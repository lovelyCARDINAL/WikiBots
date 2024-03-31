import { env } from 'process';
import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import config from '../utils/config.js';

const site = env.SITE;
const apfilterredir = env.FILTERREDIR;
const api = new MediaWikiApi(config[site].api, {
		headers: { 'user-agent': config.useragent },
	}),
	main = new MediaWikiApi(config.zh.api, {
		headers: { 'user-agent': config.useragent },
	});

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	await Promise.all([
		api.login(
			config[site].abot.name,
			config[site].abot.password,
			undefined,
			{ retry: 25, noCache: true },
		).then(console.log),
		main.login(
			config.zh.abot.name,
			config.zh.abot.password,
			undefined,
			{ retry: 25, noCache: true },
		).then(console.log),
	]);
	
	const titles = await (async () => {
		const { data: { parse: { wikitext } } } = await main.post({
			action: 'parse',
			page: 'User:星海子/BotConfig',
			prop: 'wikitext',
			section: '2',
		}, {
			retry: 15,
		});
		return wikitext.split('\n').slice(2, -1).map((page) => page.trim());
	})();

	const ids = await Promise.all(titles.map(async (title) => {
		const { data: { query: { allpages } } } = await api.post({
			list: 'allpages',
			apprefix: Parser.normalizeTitle(title).main,
			apnamespace: Parser.normalizeTitle(title).ns,
			apfilterredir,
			aplimit: 'max',
		}, {
			retry: 15,
		});
		return allpages.map(({ pageid }) => pageid);
	})).then((result) => result.flat());

	await Promise.all(ids.map(async (pageid) => {
		await api.postWithToken('csrf', {
			action: 'delete',
			pageid,
			reason: '根据页面前缀批量删除页面',
			tags: 'Bot',
			watchlist: 'nochange',
		}, {
			retry: 50,
			noCache: true,
		}).then(({ data }) => console.log(JSON.stringify(data)));
	}));

	await main.postWithToken('csrf', {
		action: 'edit',
		title: 'User:星海子/BotConfig',
		section: '2',
		text: '== Queue ==\n<poem>\n\n</poem>',
		summary: '清空任务队列',
		tags: 'Bot',
		bot: true,
		minor: true,
		nocreate: true,
		watchlist: 'nochange',
	}, {
		retry: 50,
		noCache: true,
	}).then(({ data }) => console.log(JSON.stringify(data)));

	console.log(`End time: ${new Date().toISOString()}`);
})();