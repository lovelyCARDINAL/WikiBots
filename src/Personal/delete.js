import { env } from 'process';
import Parser from 'wikiparser-node';
import mapLimit from '../utils/concurrency.js';
import { createAndLogin } from '../utils/createApi.js';
import paginate from '../utils/paginate.js';
import { safePostWithToken } from '../utils/retry.js';

Parser.config = 'moegirl';

const site = env.SITE;

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	const api = await createAndLogin(site, 'abot');

	const pagelist = await (async () => {
		const result = [];
		for await (const data of paginate(api, {
			rvprop: 'user|content',
			prop: 'revisions',
			generator: 'categorymembers',
			gcmtitle: 'Category:即将删除的页面',
			gcmprop: 'ids|title',
			gcmtype: 'page|subcat|file',
			gcmlimit: 'max',
		})) {
			if (data?.query?.pages) {
				result.push(...Object.values(data.query.pages));
			}
		}
		return result;
	})();
	if (pagelist.length === 0) {
		console.log('No pages need to be deleted.');
		return;
	}

	const { data: { query: { allusers } } } = await api.post({
		list: 'allusers',
		aurights: 'rollback',
		aulimit: 'max',
	}, {
		retry: 15,
	});
	const userlist = allusers.map(({ name }) => name);

	await mapLimit(pagelist, 5, async ({ pageid, revisions }) => {
		const { user: lastEditUser, content } = revisions?.[0] || {};
		if (!content || !userlist.includes(lastEditUser)) {
			return;
		}
		/** @type {Parser.TranscludeToken | undefined} */
		const template = Parser.parse(content)
			?.querySelector('template:regex(name, /^Template:即[将將][删刪]除$/)');
		if (!template) {
			return;
		}
		const templateUser = template.getValue('user');
		if (lastEditUser !== templateUser || !userlist.includes(templateUser)) {
			return;
		}
		const reason = template.getValue('1')?.trim() || '';
		if (!reason) {
			return;
		}

		await safePostWithToken(api, 'csrf', {
			action: 'delete',
			reason: `批量删除[[Cat:即将删除的页面]]（[[User_talk:${lastEditUser}|${lastEditUser}]]的挂删理由：${reason} ）`,
			pageid,
			tags: 'Bot',
		}, {
			retry: 50,
			noCache: true,
		});
	});

	console.log(`End time: ${new Date().toISOString()}`);
})();
