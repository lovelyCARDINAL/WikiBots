import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import config from '../utils/config.js';

const api = new MediaWikiApi(config.zh.api, {
	headers: { 'user-agent': config.useragent },
});

function templateCount(parsed) {
	let nocount = 0;
	const templates = parsed.querySelectorAll('template#Template:China_Temple_Song, template#Template:Temple_Song, template#Template:China_Legendary_Song');
	return templates.filter((template) => template.getValue('nocount') !== 'true').length;
}

function sectionCount(parsed, setData, root, sub) {
	parsed.sections()
		.slice(1) // 忽略序言
		.forEach((section) => {
			const header = section.firstChild.innerText;
			if (header in setData[root][sub]) {
				setData[root][sub][header] = templateCount(section);
			}
		});
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	await api.login(
		config.zh.ibot.name,
		config.zh.ibot.password,
		undefined,
		{ retry: 25, noCache: true },
	).then(console.log);

	const { data: { query: { pages: [{ revisions: [{ content: setPage }] }] } } } = await api.post({
		prop: 'revisions',
		titles: 'Module:VOCALOID_Song_Counter/data.json',
		rvprop: 'content',
	});
	const setData = JSON.parse(setPage);
	const titles = Object.keys(setData).flatMap((page) => {
		if (typeof setData[page] === 'number') {
			return page;
		}
		if (typeof setData[page].root === 'number' || setData[page]?.section
			|| setData[page]?.['bilibili投稿'] || setData[page]?.['YouTube投稿']) {
			return Object.keys(setData[page]).flatMap((subpage) => {
				const result = [];
				switch (subpage) {
					case 'root':
					case 'section':
						result.push(page);
						break;
					case 'bilibili投稿':
					case 'YouTube投稿':
						typeof setData[page][subpage] === 'number'
							? result.push(`${page}/${subpage}`)
							: result.push(...Object.keys(setData[page][subpage]).map((subsub) => `${page}/${subpage}/${subsub}`));
						break;
					default:
						result.push(`${page}/${subpage}`);
						break;
				}
				return result;
			});
		}
		return Object.keys(setData[page]).map((subpage) => `${page}/${subpage}`);
	});

	const { data: { query: { pages } } } = await api.post({
		prop: 'revisions',
		titles,
		rvprop: 'content',
	}, {
		retry: 15,
	});

	await Promise.all(pages.map(({ title, revisions: [{ content }] }) => {
		const [root, sub, subsub] = title.split(/\/(?!Ego)/);
		const parsed = Parser.parse(content);
		switch (sub) {
			case undefined:
				typeof setData[root]?.root === 'number'
					? setData[root].root = templateCount(parsed)
				    : setData[root]?.section
						? sectionCount(parsed, setData, root, 'section')
						: setData[root] = templateCount(parsed);
				break;
			case '梗曲相关':
				sectionCount(parsed, setData, root, sub);
				break;
			case 'YouTube投稿':
			case 'bilibili投稿':
				subsub
					? setData[root][sub][subsub] = templateCount(parsed)
					: setData[root][sub] = templateCount(parsed);
				break;
			default:
				setData[root][sub] = templateCount(parsed);
				break;
		}
	}));
	
	await api.postWithToken('csrf', {
		action: 'edit',
		title: 'Module:VOCALOID_Song_Counter/data.json',
		text: JSON.stringify(setData),
		summary: '更新歌曲统计数据',
		bot: true,
		tags: 'Bot',
		watchlist: 'nochange',
	}, {
		retry: 50,
		noCache: true,
	}).then(({ data }) => console.log(JSON.stringify(data)));
	
	console.log(`End time: ${new Date().toISOString()}`);
})();
