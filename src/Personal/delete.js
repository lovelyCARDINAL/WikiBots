import { env } from 'process';
import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import config from '../utils/config.js';

Parser.config = 'moegirl';

const site = env.SITE;
const api = new MediaWikiApi(config[site].api, {
	headers: { 'user-agent': config.useragent },
});

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	await api.login(
		config[site].abot.name,
		config[site].abot.password,
		undefined,
		{ retry: 25, noCache: true },
	).then(console.log);

	const pagelist = await (async () => {
		const result = [];
		const eol = Symbol();
		let gcmcontinue = undefined;
		while (gcmcontinue !== eol) {
			const { data } = await api.post({
				rvprop: 'user|content',
				prop: 'revisions',
				generator: 'categorymembers',
				gcmtitle: 'Category:即将删除的页面',
				gcmprop: 'ids|title',
				gcmtype: 'page|subcat|file',
				gcmlimit: 'max',
				gcmcontinue,
			}, {
				retry: 15,
			});
			gcmcontinue = data.continue ? data.continue.gcmcontinue : eol;
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
		
	await Promise.all(pagelist.map(async ({ pageid, revisions: [{ user: lastEditUser, content }] }) => {
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

		await api.postWithToken('csrf', {
			action: 'delete',
			reason: `批量删除[[Cat:即将删除的页面]]（[[User_talk:${lastEditUser}|${lastEditUser}]]的挂删理由：${reason} ）`,
			pageid,
			tags: 'Bot',
		}, {
			retry: 50,
			noCache: true,
		}).then(({ data }) => console.log(JSON.stringify(data)));
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();
