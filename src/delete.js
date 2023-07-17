import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import { env } from 'process';
import config from './utils/config.js';

const site = env.SITE;
const api = new MediaWikiApi(config[site].api, { headers: { 'api-user-agent': config.apiuseragent || '' } });

async function pageDelete(pageid, user, reason) {
	const { data } = await api.postWithToken('csrf', {
		action: 'delete',
		reason: `批量删除[[Cat:即将删除的页面]]（[[User_talk:${user}|${user}]]的挂删理由：${reason} ）`,
		pageid,
		tags: 'Automation tool',
	});
	console.log(JSON.stringify(data));
}

console.log(`Start time: ${new Date().toISOString()}`);

(async () => {
	await api.login(config[site].main.name, config[site].main.password).then(console.log, console.error);

	const { data : pagelist } = await api.post({
		rvprop: 'user|content',
		prop: 'revisions',
		generator: 'categorymembers',
		gcmtitle: 'Category:即将删除的页面',
		gcmprop: 'ids|title',
		gcmtype: 'page|subcat|file',
		gcmlimit: 'max',
	});
	if (!pagelist?.query?.pages || pagelist?.query?.pages?.length === 0) {
		console.log('No pages need to be deleted.');
		return;
	}

	const { data: { query: { allusers } } } = await api.post({
		list: 'allusers',
		aurights: 'rollback',
		aulimit: 'max',
	});
	const userlist = allusers.map(({ name }) => name);
		
	await Promise.all(pagelist.query.pages.map(async ({ pageid, revisions }) => {
		const { user: lastEditUser, content } = revisions[0];
		if (!content || !userlist.includes(lastEditUser)) {
			return;
		}
		const wikitext = Parser.parse(content);
		const templateUser = wikitext.querySelector('template#Template:即将删除').getValue('user');
		if (lastEditUser !== templateUser || !userlist.includes(templateUser)) {
			return;
		}
		const reason = wikitext.querySelector('template#Template:即将删除').getValue('1').trim();
		if (!reason) {
			return;
		}
		await pageDelete(pageid, lastEditUser, reason);
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();
