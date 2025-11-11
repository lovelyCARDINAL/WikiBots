import { Buffer } from 'buffer';
import { env } from 'process';
import { Octokit } from '@octokit/core';
import { MediaWikiApi } from 'wiki-saikou';
import config from '../utils/config.js';
import readData from '../utils/readData.js';
import splitAndJoin from '../utils/splitAndJoin.js';

const zhapi = new MediaWikiApi(config.zh.api, {
		headers: { 'user-agent': config.useragent },
	}),
	cmapi = new MediaWikiApi(config.cm.api, {
		headers: { 'user-agent': config.useragent },
	});

const octokit = new Octokit({ auth: env.GITHUB_TOKEN });

async function getDetails(title) {
	const { data: { query: { logevents } } } = await cmapi.post({
		list: 'logevents',
		leprop: 'type|details',
		ledir: 'older',
		letitle: title,
		lelimit: 'max',
	}, {
		retry: 15,
	});
	if (!logevents.length) {
		return '未曾上传';
	}
	for (const { type, params } of logevents) {
		if (type === 'delete') {
			return `被删除<span class='sysop-show'>（[https://commons.moegirl.org.cn/Special:恢复被删页面/${title.replaceAll(' ', '_')} 恢复]）</span>`;
		}
		if (type === 'move') {
			return `被移动至[[:${params.target_title}]]`;
		}
	}
	return '未知';
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	await Promise.all([
		zhapi.login(
			config.zh.ibot.name,
			config.zh.ibot.password,
			undefined,
			{ retry: 25, noCache: true },
		).then(console.log),
		cmapi.login(
			config.cm.ibot.name,
			config.cm.ibot.password,
			undefined,
			{ retry: 25, noCache: true },
		).then(console.log),
	]);

	const lastData = JSON.parse(await readData('brokenFiles.json'));
	
	const pageData = {};
	const imgData = {};
	const eol = Symbol();
	let imcontinue = undefined;
	while (imcontinue !== eol) {
		const { data } = await zhapi.post({
			prop: 'images',
			generator: 'categorymembers',
			imlimit: 'max',
			gcmtitle: 'Category:含有受损文件链接的页面',
			gcmnamespace: '0|10|12|4',
			gcmlimit: 'max',
			gcmsort: 'timestamp',
			gcmdir: 'older',
			imcontinue,
		}, {
			retry: 15,
		});
		imcontinue = data.continue ? data.continue.imcontinue : eol;

		const pagelist = Object.values(data.query.pages).filter((page) => page.images && !/Sandbox|沙盒|页面格式/i.test(page.title));

		const imageTitles = pagelist.flatMap(({ images }) => images.map(({ title }) => title));
		const imageTitlesGroup = splitAndJoin(imageTitles, 500);
		await Promise.all(imageTitlesGroup.map(async(titles) => {
			const { data: { query: { pages } } } = await cmapi.post({
				prop: 'revisions',
				titles,
				rvprop: '',
			}, {
				retry: 15,
			});
			await Promise.all(pages.map(async ({ title, missing, known }) => {
				if (missing) {
					imgData[title] = lastData?.[title] || (known ? `页面丢失<span class='sysop-show'>（[https://commons.moegirl.org.cn/Special:恢复被删页面/${title.replaceAll(' ', '_')} 恢复]）</span>` : await getDetails(title));
				}
			}));
		}));
		
		for (const page of pagelist) {
			const { pageid, title, ns, images } = page;
			pageData[pageid] ||= { title, ns, images: {} };
			const imagelist = images.map(({ title }) => title);
			for (const title of imagelist) {
				if (imgData?.[title]) {
					pageData[pageid].images[title] = imgData[title];
				}
			}
		}
	}

	try {
		const { data: { sha } } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
			owner: 'lovelyCARDINAL',
			repo: 'WikiBots',
			path: 'data/brokenFiles.json',
		});
		await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
			owner: 'lovelyCARDINAL',
			repo: 'WikiBots',
			path: 'data/brokenFiles.json',
			message: 'auto: update broken files data',
			content: Buffer.from(JSON.stringify(imgData, null, '\t'), 'utf-8').toString('base64'),
			sha,
		});
		console.log('SUCCESS!');
	} catch (error) {
		console.error('ERROR:', error.message);
	}

	let text = '* 本页面为[[U:星海-interfacebot|机器人]]生成的[[:Category:含有受损文件链接的页面|受损文件]]详细信息，完成修复的<b>任何用户</b>都可以<b class="plainlinks">[{{fullurl:{{FULLPAGENAME}}|action=edit}} 编辑下方表格]</b>。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}} \n\n{| class="wikitable sortable plainlinks" style="word-break:break-all" width=100%\n|-\n! 页面名 || 命名空间 || 文件名 || 文件状态 \n|-\n';
	for (const { title, ns, images } of Object.values(pageData)) {
		const namespace = `data-sort-value="${ns}"|${ns === 0 ? '（主）' : `{{ns:${ns}}}`}`;
		const rowspan = Object.keys(images).length;
		if (!rowspan) {
			continue;
		}
		const results = Object.keys(images).map((title) => `|[[cm:${title}|${title}]]||${images[title]}\n|-`).join('\n');
		text += rowspan === 1
			? `|[[${title}]]\n|${namespace}\n${results}\n`
			: `|rowspan=${rowspan}|[[${title}]]\n|rowspan=${rowspan} ${namespace}\n${results}\n`;
	}
	text += '|}\n[[Category:萌娘百科数据报告]][[Category:积压工作]]';

	await zhapi.postWithToken('csrf', {
		action: 'edit',
		pageid: '555599',
		text,
		summary: '更新数据报告',
		bot: true,
		notminor: true,
		tags: 'Bot',
		watchlist: 'nochange',
	}, {
		retry: 50,
		noCache: true,
	}).then(({ data }) => console.log(JSON.stringify(data)));

	console.log(`End time: ${new Date().toISOString()}`);
})();
