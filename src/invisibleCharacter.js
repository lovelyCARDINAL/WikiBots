import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';
import { getTimeData, editTimeData } from './utils/lastTime.js';
import splitAndJoin from './utils/splitAndJoin.js';

const api = new MediaWikiApi(config.zh.api, {
	headers: {
		'api-user-agent': config.apiuseragent || '',
	},
});

function replaceSpecialCharacters(wikitext, pageid, setting) {
	switch (pageid) {
		case setting['180e'].includes(pageid):
			return wikitext.replace(/[\u2005-\u200C\u200E\u200F\u2028-\u202F\u205F\u2060-\u206E\u3164\uFEFF]+/g, '');
		case setting['3164'].includes(pageid):
			return wikitext.replace(/[\u180E\u2005-\u200C\u200E\u200F\u2028-\u202F\u205F\u2060-\u206E\uFEFF]+/g, '');
		default:
			return wikitext.replace(/[\u180E\u2005-\u200C\u200E\u200F\u2028-\u202F\u205F\u2060-\u206E\u3164\uFEFF]+/g, '');
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
	});
	console.log(data);
}

console.log(`Start time: ${new Date().toISOString()}`);

api.login(config.zh.bot.name, config.zh.bot.password)
	.then(console.log, console.error)
	.then(async () => {
		const lastTime = await getTimeData();
		const rcend = lastTime['invisible-character'],
			rcstart = new Date().toISOString();
        
		const { data: { query: { recentchanges, pages: setdata } } } = await api.post({
			prop: 'revisions',
			titles: 'User:星海子/InvisibleCharacter.json',
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
        
		const setting = JSON.parse(setdata[0]?.revisions[0]?.content || '{}');
		const pagelists = splitAndJoin(
			recentchanges.map(({ pageid }) => pageid)
			, 500);
		if (!pagelists.length) {
			console.log('No pages has invisible characters.');
			return;
		}
		await Promise.all(
			pagelists.map((pagelist) =>
				api.post({
					prop: 'revisions',
					pageids: pagelist,
					rvprop: 'content',
				}).then(({ data: { query: { pages } } }) => {
					pages.forEach(async (page) => {
						const { pageid, revisions } = page;
						if (revisions.length) {
							const { content: wikitext } = revisions[0];
							await removeChar(pageid, wikitext, setting);
						}
					});
				}),
			),
		);

		await editTimeData(lastTime, 'invisible-character', rcstart);
		console.log(`End time: ${new Date().toISOString()}`);
	});