import type { MwQueryResponse } from '../types/mediawiki.d.ts';
import mapLimit from '../utils/concurrency.ts';
import { createAndLogin } from '../utils/createApi.ts';
import { safePostWithToken } from '../utils/retry.ts';

const NS_LIST = [1, 2, 3, 5, 9, 11, 13, 15, 115, 117, 118, 119, 275, 829];
const NS_REASON_MAP: Record<number, [number[], string]> = {
	13: [ [13, 5, 119], '自动删除移动讨论页面残留重定向'],
	5: [ [13, 5, 119], '自动删除移动讨论页面残留重定向'],
	2: [ [0, 10, 4, 12, 114, 116, 118], '自动删除移动用户页面残留重定向'],
	3: [ [1, 11, 5, 13, 115, 117, 119], '自动删除移动用户讨论页面残留重定向'],
	118: [ [0, 2, 4, 12, 114, 116], '自动删除移动草稿页面残留重定向'],
	119: [ [1, 3, 5, 13, 115, 117, 119], '自动删除移动草稿讨论页面残留重定向'],
};

interface MoveLogEvent {
	pageid: number;
	ns: number;
	comment: string;
	params: { suppressredirect?: boolean; target_ns: number };
	commenthidden?: boolean;
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	const api = await createAndLogin('zh', 'abot');

	const { data: { query: { logevents } } } = await api.post<{
		query: { logevents: MoveLogEvent[] };
	}>({
		list: 'logevents',
		letype: 'move',
		leprop: 'ids|title|type|user|comment|details',
		lelimit: 'max',
		lestart: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
		leend: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
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

	await mapLimit(pages, 5, async ({ pageid, ns, params }) => {
		const [targetns, reason] = NS_REASON_MAP[ns] || [ [ns], '自动删除移动讨论页面残留重定向'];
		if (!targetns.includes(params.target_ns)) {
			return;
		}
		const needsDelete = await (async () => {
			const { data: { query: { pages: [{ missing, revisions }] } } } = await api.post<MwQueryResponse<{
				pages: Array<{ missing?: boolean; revisions: Array<{ tags?: string[] }> }>;
			}>>({
				prop: 'revisions',
				pageids: pageid,
				rvprop: 'tags',
				rvlimit: '2',
			}, {
				retry: 15,
			});
			return !missing && revisions.length === 1 && revisions[0]?.tags?.includes('mw-new-redirect');
		})();
		if (needsDelete) {
			await safePostWithToken(api, 'csrf', {
				action: 'delete',
				pageid,
				reason,
				tags: 'Bot',
				watchlist: 'nochange',
			}, {
				retry: 50,
				noCache: true,
			});
		}
	});

	console.log(`End time: ${new Date().toISOString()}`);
})();
