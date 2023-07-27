import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';
import { getTimeData, editTimeData } from './utils/lastTime.js';

const api = new MediaWikiApi(config.zh.api, { headers: { 'api-user-agent': config.apiuseragent } });

const NS_LIST = ['1', '2', '3', '5', '9', '11', '13', '15', '275', '829'];
const NS_REASON_MAP = {
	13: [ [13, 5], '自动删除移动讨论页面残留重定向'],
	5: [ [13, 5], '自动删除移动讨论页面残留重定向'],
	2: [ [0, 10, 4, 12], '自动删除移动用户页面残留重定向'],
	3: [ [1, 11, 5, 13], '自动删除移动用户讨论页面残留重定向'],
};

function ruleTest(item, targetns) {
	const { params, comment } = item;
	if (params.suppressredirect || !targetns.includes(params.target_ns) || item.commenthidden) {
		return false;
	} 
	return !/(?:!nobot!|[暫暂]留)/i.test(comment);
}

async function ruleTest2(item) {
	const { title, timestamp } = item;
	const { data: { query: { pages: [{ missing, revisions, pageid }] } } } = await api.post({
		prop: 'revisions',
		titles: title,
		rvprop: 'ids|timestamp',
		rvlimit: '2',
	});
	if (missing || revisions.length > 1) {
		return false;
	}
	const { timestamp: timestamp2 } = revisions[0];
	const timeDiff = Math.abs(new Date(timestamp) - new Date(timestamp2)) < 5000;
	return timeDiff ? pageid : false;
}

async function pageDelete(pageid, reason) {
	const { data } = await api.postWithToken('csrf', {
		action: 'delete',
		pageid,
		reason,
		tags: 'Bot',
		watchlist: 'nochange',
	});
	console.log(JSON.stringify(data));
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	await api.login(config.zh.abot.name, config.zh.abot.password).then(console.log);

	const lastTime = await getTimeData();
	const leend = lastTime['redirect-deletion'],
		lestart = new Date(Date.now() - 3 * 60 * 1000).toISOString();

	await Promise.all(
		NS_LIST.map(async (ns) => {
			const [targetns, reason] = NS_REASON_MAP[ns] || [ [parseInt(ns)], '自动删除移动讨论页面残留重定向'];

			const { data: { query: { logevents: pagelist } } } = await api.post({
				list: 'logevents',
				letype: 'move',
				leprop: 'title|type|user|timestamp|comment|details',
				lenamespace: ns,
				lelimit: 'max',
				lestart,
				leend,
			});

			if (pagelist.length) {
				await Promise.all(
					pagelist.map(async (item) => {
						if (ruleTest(item, targetns)) {
							const pageid = await ruleTest2(item);
							if (pageid) {
								await pageDelete(pageid, reason);
							}
						}
					}),
				);
			} else {
				console.log(`No redirect in namespace ${ns}`);
			}
		}),
	);

	await editTimeData(lastTime, 'redirect-deletion', lestart);
	console.log(`End time: ${new Date().toISOString()}`);
})();
