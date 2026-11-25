import type { MediaWikiApi } from 'wiki-saikou';
import type { MwQueryResponse } from '../types/mediawiki.d.ts';
import { createAndLogin } from '../utils/createApi.ts';
import { safePostWithToken } from '../utils/retry.ts';

const time = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

async function isActive(api: MediaWikiApi, user: string): Promise<boolean> {
	const { data: { query: { usercontribs } } } = await api.post<MwQueryResponse<{
		usercontribs: unknown[];
	}>>({
		list: 'usercontribs',
		ucuser: user,
		ucnamespace: '*',
		uclimit: '1',
		ucend: time,
	}, {
		retry: 15,
	});
	return !usercontribs.length;
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	const api = await createAndLogin('zh', 'bot');

	const pageids = ['488029', '525904'];

	await Promise.all(pageids.map(async (pageid) => {

		const { data: { parse: { wikitext } } } = await api.post<{
			parse: { wikitext: string };
		}>({
			action: 'parse',
			pageid,
			prop: 'wikitext',
			section: '1',
		}, {
			retry: 15,
		});

		const userlist = await (async () => {
			const data: string[] = [];
			const regex = /\[\[User talk:(.+?)(?:\/.+?)?\]\]/g;
			const matches = Array.from(wikitext.matchAll(regex));
			await Promise.all(matches.map(async (match) => {
				const user = match[1];
				if (await isActive(api, user)) {
					data.push(user);
				}
			}));
			return data;
		})();
		
		if (userlist.length) {
			const userlistString = userlist.map((user) => user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
			const userRegex = new RegExp(`#[ _]\\[\\[User[ _]talk:(${userlistString})(\\/[^\\]]+)?\\]\\]\n`, 'gi');
			const text = wikitext.replace(userRegex, '');
			
			await safePostWithToken(api, 'csrf', {
				action: 'edit',
				pageid,
				text,
				section: '1',
				summary: '移除超过90日不活跃的订阅者',
				tags: 'Bot',
				notminor: true,
				bot: true,
				nocreate: true,
				watchlist: 'nochange',
			}, {
				retry: 50,
				noCache: true,
			});
		}
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();