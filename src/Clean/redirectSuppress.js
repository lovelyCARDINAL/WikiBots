import { MediaWikiApi } from 'wiki-saikou';
import config from '../utils/config.js';

const SITE_LIST = ['zh', 'cm'];

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	const zhapi = new MediaWikiApi(config.zh.api, {
		headers: { 'user-agent': config.useragent },
	});
	await zhapi.login(
		config.zh.abot.name,
		config.zh.abot.password,
		undefined,
		{ retry: 25, noCache: true },
	).then(console.log);

	const userids = await (async () => {
		const { data: { query: { allusers } } } = await zhapi.post({
			list: 'allusers',
			augroup: ['sysop', 'patroller', 'bot', 'staff'],
			aulimit: 'max',
		}, {
			retry: 10,
		});
		return allusers.map(({ userid }) => userid);
	})();
	
	await Promise.all(SITE_LIST.map(async (site) => {
		let api;
		if (site === 'zh') {
			api = zhapi;
		} else {
			api = new MediaWikiApi(config[site].api, {
				headers: { 'user-agent': config.useragent },
			});
			await api.login(
				config[site].abot.name,
				config[site].abot.password,
				undefined,
				{ retry: 25, noCache: true },
			).then(console.log);
		}

		const { data: { query: { logevents } } } = await api.post({
			list: 'logevents',
			letype: 'move',
			leprop: 'ids|userid|comment|details',
			lelimit: 'max',
			leend: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
		}, {
			retry: 15,
		});

		const pages = logevents.filter(({ pageid, comment, params, commenthidden, userid }) => pageid !== 0
		&& userids.includes(userid)
		&& /不留重(定|新導)向|suppressredirec|no ?redir(ec)?|no ?rdr/i.test(comment)
		&& !params.suppressredirect
		&& !commenthidden,
		);

		if (!pages.length) {
			console.log('No pages to delete.');
		}

		await Promise.all(pages.map(async ({ pageid }) => {
			const { data: { query: { pages: [{ missing, revisions }] } } } = await api.post({
				prop: 'revisions',
				pageids: pageid,
				rvprop: 'tags',
				rvlimit: '2',
			}, {
				retry: 15,
			});
			if (!missing && revisions.length === 1 && revisions[0]?.tags?.includes('mw-new-redirect')) {
				await api.postWithToken('csrf', {
					action: 'delete',
					pageid,
					reason: '移动不留重定向',
					tags: 'Bot',
					watchlist: 'nochange',
				}, {
					retry: 50,
					noCache: true,
				}).then(({ data }) => console.log(JSON.stringify(data)));
			}
		}));
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();
