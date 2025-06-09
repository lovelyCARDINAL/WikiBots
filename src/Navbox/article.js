import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import config from '../utils/config.js';

Parser.config = 'moegirl';

const api = new MediaWikiApi(config.zh.api, {
	headers: { 'user-agent': config.useragent },
});

async function querySearch(srsearch) {
	const { data: { query: { search } } } = await api.post({
		list: 'search',
		srsearch,
		srnamespace: [0, 4, 12],
		srlimit: 'max',
		srinfo: '',
		srprop: '',
	}, {
		retry: 25,
	});
	return search;
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	await api.login(
		config.zh.ibot.name,
		config.zh.ibot.password,
		undefined,
		{ retry: 25, noCache: true },
	).then(console.log);

	const pageids = await Promise.all([
		querySearch('hastemplate:"navbox" insource:"navbox"'),
		querySearch('insource:"invoke:nav"'),
		querySearch('insource:"大家族" hastemplate:"大家族"'),
	]).then((result) => result.flat().map(({ pageid }) => pageid));

	const { data: { query: { pages } } } = await api.post({
		prop: 'revisions',
		pageids,
		rvprop: 'content',
	}, {
		retry: 25,
	});
	const navdata = new Set();

	await Promise.all(pages.map(({ title, revisions: [{ content }] }) => {
		const wikitext = Parser.parse(content, true);
		const template = wikitext.querySelector('template:regex("name, /^Template:(?:Navbox(?:_with_collapsible_groups|_with_columns)?|大家族(?:模板)?)$/i"), magic-word#invoke[module=Module:Nav]');
		if (template) {
			const name = template.getValue('name')?.trim();
			const talkpage = Parser.normalizeTitle(title).toTalkPage().title;
			navdata.add([talkpage, name]);
		}
	}));

	const talkpages = await api.post({
		list: 'categorymembers',
		cmtitle: 'Category:页面中存在错误的大家族模板',
		cmlimit: 'max',
		cmprop: '',
	}, {
		retry: 25,
	}).then(({ data: { query: { categorymembers } } }) => categorymembers.map(({ title }) => title));

	for (const data of navdata) {
		if (data[0] in talkpages || data[0] === 'Help talk:常用模板') {
			navdata.delete(data);
		}
	}
	
	await Promise.all([...navdata].map(async ([title, name]) => {
		await api.postWithToken('csrf', {
			action: 'edit',
			title,
			prependtext: `{{warn navbox|name=${name}}}\n\n`,
			summary: '提醒页面中存在错误的大家族模板',
			notminor: true,
			bot: true,
			tags: 'Bot',
			watchlist: 'nochange',
		}, {
			retry: 50,
			noCache: true,
		}).then(({ data }) => console.log(JSON.stringify(data)));
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();
