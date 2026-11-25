import axios from 'axios';
import axiosRetry from 'axios-retry';
import jsonpath from 'jsonpath';
import type { MediaWikiApi } from 'wiki-saikou';
import { createAndLogin } from '../utils/createApi.ts';
import { safePostWithToken } from '../utils/retry.ts';
import splitAndJoin from '../utils/splitAndJoin.ts';

axiosRetry(axios, {
	retries: 3,
	retryDelay: (retryCount) => {
		return retryCount * 1000;
	},
});

function findImageSrc(data: unknown): string[] {
	const matches = jsonpath.query(data, '$..imageSrc') as string[];
	const regex = /(?:(?:app)\.moegirl\.org|aojiaostudio\.com|storage\.moegirl\.org(?=.*\/moegirl\/(?!commons\/|en\/|ja\/|library\/)))/i;
	return matches.filter((match) => match && !regex.test(match));
}

async function getMainpageJson(part: string): Promise<string[]> {
	const url = `https://storage.moegirl.org.cn/homeland/data/${part}.json`;
	const response = await axios.get(url, { timeout: 15000 });
	return findImageSrc(response.data);
}

function findImageName(imgSrc: string): { bad_image_info: string; image_name: string } {
	const result = {
		bad_image_info: '',
		image_name: '',
	};
	const regex = /(?:https:\/\/commons\.moegirl\.org\.cn\/thumb\.php\?[^\s=]*=([^&]+))|(?:https:\/\/(?:img|storage)\.moegirl\.org\.cn\/(?:common\/[a-f0-9]\/[a-f0-9]{2}|moegirl\/commons\/[a-f0-9]\/[a-f0-9]{2})\/([^/!?]+))/i;
	const match = imgSrc.match(regex);
	console.log(`Finding image name from src: ${imgSrc}`);
	if (match) {
		const rawName = match[1] || match[2];
		try {
			result.image_name = decodeURIComponent(rawName);
		} catch {
			result.image_name = rawName;
		}
		return result;
	}
	result.bad_image_info = `* 非法图片：<code><nowiki>${imgSrc}</nowiki></code>\n`;
	return result;
}

async function pageProtect(cmapi: MediaWikiApi, title: string, protections: string, reason: string): Promise<void> {
	await safePostWithToken(cmapi, 'csrf', {
		action: 'protect',
		reason,
		protections,
		title,
		...protections && { expiry: 'infinite' },
		tags: 'Bot',
		watchlist: 'nochange',
	}, {
		retry: 50,
		noCache: true,
	});
}

async function pageEdit(zhapi: MediaWikiApi, title: string, text: string, summary: string, sectiontitle?: string): Promise<void> {
	await safePostWithToken(zhapi, 'csrf', {
		action: 'edit',
		title,
		...sectiontitle && { section: 'new', sectiontitle },
		text,
		tags: 'Bot',
		summary,
		watchlist: 'nochange',
		bot: true,
		nocreate: true,
		notminor: true,
	}, {
		retry: 50,
		noCache: true,
	});
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	const partlist = ['banner-slider', 'topics-acgn', 'topics-weekly-bangumi', 'topics-vtubers', 'topics-music', 'topics-memes', 'topics-others', 'topics-weekly-bangumi-30'];
	const imgSrcGroup = await Promise.all(
		partlist.map((part) => getMainpageJson(part)),
	);
	const imgSrcList = imgSrcGroup.flat();

	const imgNameList: string[] = [],
		badImageInfo = '';
	await Promise.all(
		imgSrcList.map((imgSrc) => findImageName(imgSrc)),
	).then((results) => {
		results.forEach((result) => {
			if (result.image_name) {
				imgNameList.push(`File:${result.image_name}`);
			} else {
				badImageInfo.concat(result.bad_image_info);
			}
		});
	});
	const newImgList = imgNameList.filter((value, index) => imgNameList.indexOf(value) === index);
	newImgList.sort();

	const [cmapi, zhapi] = await Promise.all([
		createAndLogin('cm', 'abot'),
		createAndLogin('zh', 'abot'),
	]);
	
	const imgNameLists = splitAndJoin(newImgList, 500);
	
	await Promise.all(
		imgNameLists.map(async (titles) => {
			const { data: { query: { pages } } } = await cmapi.post<{
				query: {
					pages: Record<string, { title: string; missing?: boolean; redirect?: boolean; protection: unknown[] }>;
				};
			}>({
				prop: 'info',
				titles,
				inprop: 'protection',
			}, {
				retry: 15,
			});

			await Promise.all(
				Object.values(pages).map(async (item) => {
					if (item.missing) {
						badImageInfo.concat(`* 页面不存在：${item.title}\n`);
					} else if (item.redirect) {
						badImageInfo.concat(`* 重定向页面：${item.title}\n`);
					} else if (!item.protection.length) {
						await pageProtect(cmapi, item.title, 'edit=patrolleredit|move=sysop|upload=sysop', '首页图片');
					}
				}),
			);
		}),
	);

	if (badImageInfo) {
		await pageEdit(zhapi, 'User_talk:星海子/MainpageImage.json', badImageInfo, '报告问题图片', '{{subst:#time:Y年n月j日|||1}}');
	} else {
		console.log('No bad image!');
	}

	const { data: { parse: { wikitext } } } = await zhapi.post<{
		parse: { wikitext: string };
	}>({
		action: 'parse',
		page: 'User:星海子/BotData/mainpageImage.json',
		prop: 'wikitext',
	}, {
		retry: 15,
	});
	const originImgList = JSON.parse(wikitext).sort() as string[];

	if (JSON.stringify(newImgList) === JSON.stringify(originImgList)) {
		console.log('No change!');
	} else {
		await pageEdit(zhapi, 'User:星海子/BotData/mainpageImage.json', JSON.stringify(newImgList), '更新首页图片数据');

		const delImgList = originImgList.filter((imgName) => !newImgList.includes(imgName));
		if (delImgList.length) {
			await Promise.all(
				delImgList.map(async (title) => {
					await pageProtect(cmapi, title, '', '不再作为首页图片');
				}),
			);
		}
	}

	console.log(`End time: ${new Date().toISOString()}`);
	
})();