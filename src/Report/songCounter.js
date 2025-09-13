import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import config from '../utils/config.js';

const api = new MediaWikiApi(config.zh.api, {
	headers: { 'user-agent': config.useragent },
});

function templateCount(parsed) {
	let nocount = 0;
	const templates = parsed.querySelectorAll('template#Template:China_Temple_Song, template#Template:Temple_Song, template#Template:China_Legendary_Song');
	for (const template of templates) {
		const arg = template.getArg('nocount');
		if (arg && arg.value.trim() === 'true') {
			nocount++;
		}
	}
	return templates.length - nocount;
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
		if (typeof setData[page] !== 'number') {
			return Object.keys(setData[page]).map((subpage) => `${page}/${subpage}`);
		} 
		return [page];
	});

	const { data: { query: { pages } } } = await api.post({
		prop: 'revisions',
		titles,
		rvprop: 'content',
	}, {
		retry: 15,
	});

	await Promise.all(pages.map(({ title, revisions: [{ content }] }) => {
		const [root, sub] = title.split('/');
		const parsed = Parser.parse(content);
		switch (sub) {
			case undefined:
				setData[root] = templateCount(parsed);
				break;
			case '梗曲相关':
				parsed.sections().forEach((section) => {
					const sectionParsed = Parser.parse(section.toString());
					const { childNodes: [headerParsed] } = sectionParsed;
					const header = headerParsed.innerText;
					if (header in setData[root][sub]) {
						setData[root][sub][header] = templateCount(sectionParsed);
					}
				});
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
