import process from 'process';
import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';
import { getTimeData, editTimeData } from './utils/lastTime.js';
import splitAndJoin from './utils/splitAndJoin.js';

const api = new MediaWikiApi(config.zh.api, { headers: { 'api-user-agent': config.apiuseragent } });

const regexMap = {
	'180e': /[\u2005-\u200C\u200E\u200F\u2028-\u202F\u205F\u2060-\u206E\u3164\uFEFF]+/g,
	3164: /[\u180E\u2005-\u200C\u200E\u200F\u2028-\u202F\u205F\u2060-\u206E\uFEFF]+/g,
	'default': /[\u180E\u2005-\u200C\u200E\u200F\u2028-\u202F\u205F\u2060-\u206E\u3164\uFEFF]+/g,
};

function replaceSpecialCharacters(wikitext, pageid, setting) {
	switch (true) {
		case setting['180e'].includes(pageid):
			return wikitext.replaceAll(regexMap['180e'], '');
		case setting['3164'].includes(pageid):
			return wikitext.replaceAll(regexMap['3164'], '');
		default:
			return wikitext.replaceAll(regexMap.default, '');
	}
}

async function removeChar(pageid, wikitext, setting) {
	const { data } = await api.postWithToken('csrf', {
		action: 'edit',
		pageid,
		text: replaceSpecialCharacters(wikitext, pageid, setting),
		minor: true,
		bot: true,
		nocreate: true,
		tags: 'Bot',
		summary: '移除不可见字符',
		watchlist: 'nochange',
	}, { retry: 10, noCache: true });
	console.log(JSON.stringify(data));
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	await api.login(config.zh.bot.name, config.zh.bot.password).then(console.log);

	const lastTime = await getTimeData();
	const rcend = lastTime['invisible-character'] ?? (console.error('No last time data!'), process.exit(1)),
		rcstart = new Date().toISOString();
        
	const { data: { query: { recentchanges, pages: [{ revisions: [{ content }] }] } } } = await api.post({
		prop: 'revisions',
		titles: 'User:星海子/BotConfig/invisibleCharacter.json',
		rvprop: 'content',
		list: 'recentchanges',
		rcprop: 'timestamp|ids',
		rcstart,
		rcend,
		rclimit: 'max',
		rcnamespace: '*',
		rctag: 'invisibleCharacter',
		rctoponly: true,
	});

	const setting = JSON.parse(content || '{}');
	const pagelists = splitAndJoin(
		recentchanges.map(({ pageid }) => pageid)
		, 500);
	if (pagelists.length) {
		await Promise.all(
			pagelists.map(async(pagelist) => {
				const { data: { query: { pages } } } = await api.post({
					prop: 'revisions',
					pageids: pagelist,
					rvprop: 'content',
				});
				await Promise.all(
					pages.map(async (page) => {
						const { pageid, revisions } = page;
						if (revisions.length) {
							const { content: wikitext } = revisions[0];
							await removeChar(pageid, wikitext, setting);
						}
					}),
				);
			}),
		);
	} else {
		console.log('No pages has invisible characters.');
	}

	await editTimeData(lastTime, 'invisible-character', rcstart);
	console.log(`End time: ${new Date().toISOString()}`);
})();