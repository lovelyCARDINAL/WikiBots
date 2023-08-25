import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';

const SITE_LIST = ['zh', 'cm'];
const api = {};

const PROTECTION_MAP = {
	missing: [
		{ type: 'create', level: 'sysop', expiry: 'infinity' },
	],
	normal: [
		{ type: 'edit', level: 'sysop', expiry: 'infinity' },
		{ type: 'move', level: 'sysop', expiry: 'infinity' },
	],
};

function isEqual(array, key) {
	return array.length === PROTECTION_MAP[key].length && array.every(({ type, level, expiry }, index) => {
		const { type: type2, level: level2, expiry: expiry2 } = PROTECTION_MAP[key][index];
		return type === type2 && level === level2 && expiry === expiry2;
	});
}

async function protect(site, title, protections) {
	await api[site].postWithToken('csrf', {
		action: 'protect',
		title,
		protections,
		expiry: 'infinite',
		reason: '公告、原因表单和黑白名单等仅限管理员使用的页面',
		tags: 'Bot',
		watchlist: 'nochange',
	}, {
		retry: 30,
		noCache: true,
	}).then(({ data }) => console.log(JSON.stringify(data)));
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	console.groupCollapsed('LOGIN');
	await Promise.all(SITE_LIST.map(async(site) => {
		api[site] = new MediaWikiApi(config[site].api, {
			headers: { 'api-user-agent': config.apiuseragent },
		});
		await api[site].login(config[site].abot.name, config[site].abot.password).then((result) => console.log(site, result));
	}));
	console.groupEnd();

	const pageGroup = await (async () => {
		const { data: { query: { pages: [{ revisions: [{ content }] }] } } } = await api.zh.post({
			prop: 'revisions',
			titles: 'User:星海子/BotConfig/interfaceProtection.json',
			rvprop: 'content',
		}, {
			retry: 15,
		});
		const setData = JSON.parse(content);
		const results = {};
		Object.keys(setData).map((key) => {
			setData[key].site.map((site) => {
				results[site] = results[site]
					?.concat(setData[key].title.map((title) => `MediaWiki:${title}`))
					|| setData[key].title.map((title) => `MediaWiki:${title}`);
			});
		});
		return results;
	})();

	await Promise.all(SITE_LIST.map(async(site) => {
		await api[site].post({
			action: 'query',
			prop: 'info',
			titles: pageGroup[site],
			inprop: 'protection',
		}, {
			retry: 15,
		}).then(async ({ data: { query: { pages } } }) => {
			console.groupCollapsed(site.toUpperCase());
			await Promise.all(pages.map(async({ title, missing, protection }) => {
				missing
					? isEqual(protection, 'missing')
						? console.log(`${title} is protected`)
						: await protect(site, title, protection)
					: isEqual(protection, 'normal')
						? console.log(`${title} is protected`)
						: await protect(site, title, protection);
			}));
			console.groupEnd();
		});
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();