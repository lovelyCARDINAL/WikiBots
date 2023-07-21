import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';

const api = new MediaWikiApi(config.zh.api, { headers: { 'api-user-agent': config.apiuseragent || '' } });

const time = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

async function isActive(user) {
	const { data: { query: { usercontribs } } } = await api.post({
		list: 'usercontribs',
		ucuser: user,
		ucnamespace: '*',
		uclimit: '1',
		ucend: time,
	});
	return !usercontribs.length;
}

console.log(`Start time: ${new Date().toISOString()}`);

(async () => {
	await api.login(config.zh.bot.name, config.zh.bot.password).then(console.log, console.error);

	const { data: { parse: { wikitext } } } = await api.post({
		action: 'parse',
		pageid: '488029',
		prop: 'wikitext',
		section: '1',
	});

	const userlist = await (async () => {
		const data = [];
		const regex = /\[\[User talk:(.+?)(?:\/.+?)?\]\]/g;
		const matches = Array.from(wikitext.matchAll(regex));
		await Promise.all(matches.map(async (match) => {
			const user = match[1];
			if (await isActive(user)) {
				data.push(user);
			}
		}));
		return data;
	})();
		
	if (userlist.length) {
		const userRegex = new RegExp(`#[ _]\\[\\[User[ _]talk:(${userlist.join('|')})(\\/[^\\]]+)?\\]\\]\n`, 'gi');
		const text = wikitext.replace(userRegex, '');
			
		const { data } = await api.postWithToken('csrf', {
			action: 'edit',
			pageid: '488029',
			text,
			section: '1',
			summary: '移除超过90日不活跃的订阅者',
			tags: 'Bot',
			notminor: true,
			bot: true,
			nocreate: true,
			watchlist: 'nochange',
		});
		console.log(JSON.stringify(data));
	}

	console.log(`End time: ${new Date().toISOString()}`);
})();