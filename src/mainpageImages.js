import axios from 'axios';
import axiosRetry from 'axios-retry';
import jsonpath from 'jsonpath';
import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';
import splitAndJoin from './utils/splitAndJoin.js';

const zhapi = new MediaWikiApi(config.zh.api, {
		headers: { 'api-user-agent': config.apiuseragent },
	}),
	cmapi = new MediaWikiApi(config.cm.api, {
		headers: { 'api-user-agent': config.apiuseragent },
	});

axiosRetry(axios, {
	retries: 3,
	retryDelay: (retryCount) => {
		return retryCount * 1000;
	},
});

function findImageSrc(data) {
	const matches = jsonpath.query(data, '$..imageSrc');
	const regex = /(?:(?:app|storage)\.moegirl\.org|aojiaostudio\.com\/meogirl)/i;
	return matches.filter((match) => match && !regex.test(match));
}

async function getMainpageJson(part) {
	const url = `https://storage.moegirl.org.cn/homeland/data/${part}.json`;
	const response = await axios.get(url);
	return findImageSrc(response.data);
}

function findImageName(imgSrc) {
	const result = {
		bad_image_info: '',
		image_name: '',
	};
	if (imgSrc.startsWith('https://commons.moegirl.org.cn/thumb.php')) {
		result.image_name = decodeURIComponent(imgSrc.split('=')[1].split('&')[0]);
		return result;
	}
	if (imgSrc.startsWith('https://img.moegirl.org.cn/common/')) {
		const imgSrcSplit = imgSrc.split('/');
		if (imgSrcSplit[4] === 'thumb' && /\d/.test(imgSrcSplit.slice(-1)[0][0])) {
			result.image_name = decodeURIComponent(imgSrcSplit[7]);
			return result;
		}
		if (imgSrcSplit[4] !== 'thumb') {
			result.image_name = decodeURIComponent(imgSrcSplit[6]);
			return result;
		}
	}
	result.bad_image_info = `* 非法图片：<code><nowiki>${imgSrc}</nowiki></code>\n`;
	return result;
}

async function pageProtect(title, protections, reason) {
	await cmapi.postWithToken('csrf', {
		action: 'protect',
		reason,
		protections,
		title,
		...protections && { expiry: 'infinite' },
		tags: 'Bot',
		watchlist: 'nochange',
	}, {
		retry: 30,
		noCache: true,
	}).then(({ data }) => console.log(JSON.stringify(data)));
}

async function pageEdit(title, text, summary, sectiontitle) {
	await zhapi.postWithToken('csrf', {
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
		retry: 30,
		noCache: true,
	}).then(({ data }) => console.log(JSON.stringify(data)));
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	const partlist = ['banner-slider', 'topics-acgn', 'topics-weekly-bangumi', 'topics-vtubers', 'topics-music', 'topics-memes', 'topics-others'];
	const imgSrcGroup = await Promise.all(
		partlist.map((part) => getMainpageJson(part)),
	);
	const imgSrcList = imgSrcGroup.flat();

	const imgNameList = [],
		badImageInfo = '';
	await Promise.all(
		imgSrcList.map((imgSrc) => findImageName(imgSrc)),
	).then((results) => {
		results.forEach((result) => {
			result.image_name ? imgNameList.push(`File:${result.image_name}`) : badImageInfo.concat(result.bad_image_info);
		});
	});
	const newImgList = imgNameList.filter((value, index) => imgNameList.indexOf(value) === index);
	newImgList.sort();

	await Promise.all([
		cmapi.login(config.cm.abot.name, config.cm.abot.password).then(console.log),
		zhapi.login(config.zh.abot.name, config.zh.abot.password).then(console.log),
	]);
	
	const imgNameLists = splitAndJoin(newImgList, 500);
	
	await Promise.all(
		imgNameLists.map(async (titles) => {
			const { data: { query: { pages } } } = await cmapi.post({
				prop: 'info',
				titles,
				inprop: 'protection',
			}, {
				retry: 15,
			});

			await Promise.all(
				Object.values(pages).map(async(item) => {
					if (item.missing) {
						badImageInfo.concat(`* 页面不存在：${item.title}\n`);
					} else if (item.redirect) {
						badImageInfo.concat(`* 重定向页面：${item.title}\n`);
					} else if (!item.protection.length) {
						await pageProtect(item.title, 'edit=patrolleredit|move=sysop|upload=sysop', '首页图片');
					}
				}),
			);
		}),
	);

	if (badImageInfo) {
		await pageEdit('User_talk:星海子/MainpageImage.json', badImageInfo, '报告问题图片', '{{subst:#time:Y年n月j日|||1}}');
	} else {
		console.log('No bad image!');
	}

	const { data: { parse: { wikitext } } } = await zhapi.post({
		action: 'parse',
		page: 'User:星海子/BotData/mainpageImage.json',
		prop: 'wikitext',
	}, {
		retry: 15,
	});
	const originImgList = JSON.parse(wikitext).sort();

	if (JSON.stringify(newImgList) === JSON.stringify(originImgList)) {
		console.log('No change!');
	} else {
		await pageEdit('User:星海子/BotData/mainpageImage.json', JSON.stringify(newImgList), '更新首页图片数据');

		const delImgList = originImgList.filter((imgName) => !newImgList.includes(imgName));
		if (delImgList.length) {
			await Promise.all(
				delImgList.map(async (title) => {
					await pageProtect(title, '', '不再作为首页图片');
				}),
			);
		}
	}

	console.log(`End time: ${new Date().toISOString()}`);
	
})();