import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';

const api = new MediaWikiApi(config.zh.api, {
	headers: { 'user-agent': config.useragent },
});

const NS_LIST = [1, 2, 3, 5, 9, 11, 13, 15, 275, 829];
const NS_REASON_MAP = {
	13: [ [13, 5], '自动删除移动讨论页面残留重定向'],
	5: [ [13, 5], '自动删除移动讨论页面残留重定向'],
	2: [ [0, 10, 4, 12], '自动删除移动用户页面残留重定向'],
	3: [ [1, 11, 5, 13], '自动删除移动用户讨论页面残留重定向'],
};

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	await api.login(
		config.zh.abot.name,
		config.zh.abot.password,
		undefined,
		{ retry: 25, noCache: true },
	).then(console.log);

	const { data: { query: { logevents } } } = await api.post({
		list: 'logevents',
		letype: 'move',
		leprop: 'ids|title|type|user|timestamp|comment|details',
		lelimit: 'max',
		lestart: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
		leend: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
	}, {
		retry: 15,
	});

	const pages = logevents.filter(({ pageid, ns, comment, params, commenthidden }) => pageid !== 0
		&& NS_LIST.includes(ns)
		&& !/(?:!nobot!|[暫暂]留)/i.test(comment)
		&& !params.suppressredirect
		&& !commenthidden,
	);

	if (!pages.length) {
		console.log('No pages to delete.');
	}

	await Promise.all(pages.map(async ({ pageid, ns, params, timestamp }) => {
		const [targetns, reason] = NS_REASON_MAP[ns] || [ [ns], '自动删除移动讨论页面残留重定向'];
		if (!targetns.includes(params.target_ns)) {
			return;
		}
		const needsDelete = await (async () => {
			const { data: { query: { pages: [{ missing, revisions }] } } } = await api.post({
				prop: 'revisions',
				pageids: pageid,
				rvprop: 'timestamp',
				rvlimit: '2',
			}, {
				retry: 15,
			});
			if (missing || revisions.length > 1) {
				console.log(pageid, missing, revisions?.length);
				return false;
			}
			const { timestamp: timestamp2 } = revisions[0];
			return Math.abs(new Date(timestamp) - new Date(timestamp2)) < 5000;
		})();
		if (needsDelete) {
			await api.postWithToken('csrf', {
				action: 'delete',
				pageid,
				reason,
				tags: 'Bot',
				watchlist: 'nochange',
			}, {
				retry: 50,
				noCache: true,
			}).then(({ data }) => console.log(JSON.stringify(data)));
		}
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();
