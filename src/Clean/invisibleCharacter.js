import { env } from 'process';
import { MediaWikiApi } from 'wiki-saikou';
import config from '../utils/config.js';
import splitAndJoin from '../utils/splitAndJoin.js';

const site = env.SITE;
const api = new MediaWikiApi(config[site].api, {
	headers: { 'user-agent': config.useragent },
});

const regexMap = {
	'180e': /[\u2005-\u200C\u200E\u200F\u2028-\u202F\u205F\u2060-\u206E\u3164\uFEFF]+/g,
	3164: /[\u180E\u2005-\u200C\u200E\u200F\u2028-\u202F\u205F\u2060-\u206E\uFEFF]+/g,
	'default': /[\u180E\u2005-\u200C\u200E\u200F\u2028-\u202F\u205F\u2060-\u206E\u3164\uFEFF]+/g,
};

const replaceSpecialCharacters = (wikitext, pageid, setting) => {
	switch (true) {
		case setting['180e']?.includes(pageid):
			return wikitext.replaceAll(regexMap['180e'], '');
		case setting['3164']?.includes(pageid):
			return wikitext.replaceAll(regexMap['3164'], '');
		default:
			return wikitext.replaceAll(regexMap.default, '');
	}
};

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	await api.login(
		config[site].bot.name,
		config[site].bot.password,
		undefined,
		{ retry: 25, noCache: true },
	).then(console.log);
        
	const { data: { query: { recentchanges, pages: [{ revisions: [{ content }] }] } } } = await api.post({
		prop: 'revisions',
		titles: 'User:星海子/BotConfig/invisibleCharacter.json',
		rvprop: 'content',
		list: 'recentchanges',
		rcprop: 'timestamp|ids',
		rcend: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
		rclimit: 'max',
		rcnamespace: '*',
		rctag: 'invisibleCharacter',
		rctoponly: true,
	}, {
		retry: 15,
	});

	const setting = JSON.parse(content || '{}');
	const pagelists = splitAndJoin(
		recentchanges.map(({ pageid }) => pageid)
		, 500);
	if (pagelists.length) {
		await Promise.all(pagelists.map(async(pagelist) => {
			const { data: { query: { pages } } } = await api.post({
				prop: 'revisions',
				pageids: pagelist,
				rvprop: 'content',
			}, {
				retry: 15,
			});
			await Promise.all(pages.map(async (page) => {
				const { pageid, revisions } = page;
				if (revisions.length) {
					const { content: wikitext } = revisions[0];
					await api.postWithToken('csrf', {
						action: 'edit',
						pageid,
						text: replaceSpecialCharacters(wikitext, pageid, setting),
						minor: true,
						bot: true,
						nocreate: true,
						tags: 'Bot',
						summary: '移除不可见字符',
						watchlist: 'nochange',
					}, {
						retry: 50,
						noCache: true,
					}).then(({ data }) => console.log(JSON.stringify(data)));
				}
			}));
		}));
	} else {
		console.log('No pages has invisible characters.');
	}

	console.log(`End time: ${new Date().toISOString()}`);
})();