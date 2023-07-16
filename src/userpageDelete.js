
import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';

const api = new MediaWikiApi(config.zh.api, { headers: { 'api-user-agent': config.apiuseragent || '' } });

console.log(`Start time: ${new Date().toISOString()}`);

async function ruleTest(title, pageid, maintainlist) {
	const rootuser = title.replace(/^User:(.+?)(?:\/.*)?$/, '$1');

	const { data:{ query:{ pages } } } = await api.post({
		prop: 'revisions',
		pageids: pageid,
		rvprop: 'user',
		rvlimit: 'max',
		rvdir: 'newer',
	});
	const editlist = pages[0].revisions.map((item) => item.user);

	const isCreator = editlist[0] === rootuser;
	const exuserlist = editlist.filter((element) => !maintainlist.includes(element) && element !== rootuser);

	return isCreator && exuserlist.length === 0;
}

async function pageDelete(pageid) {
	const { data } = await api.postWithToken('csrf', {
		action: 'delete',
		pageid,
		reason: '自动删除悬挂{{[[Template:ns2d|ns2d]]}}的用户页面',
		tags: 'Bot',
		watchlist: 'nochange',
	});
	console.log(JSON.stringify(data));
}

async function cannotDelete(pageid) {
	const { data:{ query:{ pages } } } = await api.post({
		prop: 'revisions',
		pageids: pageid,
		rvprop: 'content',
	});
	let wikitext = pages[0].revisions[0].content;
	wikitext = wikitext.replace(/(?:<noinclude>\s*)?{{\s*(?:T:|模板:|[样樣]板:|Template:)?\s*ns2d\s*}}(?:\s*<\/noinclude>)?/gi, '');
	const { data } = await api.postWithToken('csrf', {
		action: 'edit',
		pageid,
		tags: 'Bot',
		watchlist: 'nochange',
		text: wikitext,
		minor: true,
		bot: true,
		summary: '无法自动删除，请至[[萌娘百科_talk:讨论版/操作申请]]提请维护人员删除。',
	});
	console.log(JSON.stringify(data));
}

(async () => {
	await api.login(config.zh.abot.name, config.zh.abot.password).then(console.log, console.error);

	const [ { data: usergroup }, { data: botlist } ] = await Promise.all([
		api.post({
			prop: 'revisions',
			titles: 'Module:UserGroup/data',
			rvprop: 'content',
		}),
		api.post({
			list: 'allusers',
			augroup: 'bot',
			aulimit: 'max',
		}),
	]);
	const { sysop, patroller, staff } = JSON.parse(
		usergroup.query.pages[0].revisions[0].content,
	);
	const bot = botlist.query.allusers.map((user) => user.name);
	const maintainlist = [ ...sysop, ...patroller, ...staff, ...bot ];
		
	const { data } = await api.post({
		action: 'query',
		prop: 'transcludedin',
		titles: 'Template:Ns2d',
		tiprop: 'pageid|title',
		tinamespace: '2',
		tilimit: 'max',
	});
	const pagedata = data.query.pages[0];
	if (Object.prototype.hasOwnProperty.call(pagedata, 'transcludedin')){
		const pagelist = pagedata.transcludedin;
		await Promise.all(
			pagelist.map(async (page) => {
				const { title, pageid } = page;
				if (await ruleTest(title, pageid, maintainlist)) {
					await pageDelete(pageid);
				} else {
					await cannotDelete(pageid);
				}
			}),
		);
	} else {
		console.log('The pages that embed the {{ns2d}} do not exist currently.');
	}
	
	console.log(`End time: ${new Date().toISOString()}`);
})();