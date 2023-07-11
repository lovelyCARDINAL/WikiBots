
import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';

const api = new MediaWikiApi(config.api.zh, {
	headers: {
		'api-user-agent': config.apiuseragent || '',
	},
});

console.log(`Start time: ${new Date().toISOString()}`);

async function rule_test(title, pageid, maintainlist) {
	const rootuser = title.replace(/^User:(.+?)(?:\/.*)?$/, '$1');

	const pagedata = await api.get({
		prop: 'revisions',
		pageids: pageid,
		rvprop: 'user',
		rvlimit: 'max',
		rvdir: 'newer',
	});
	const editlist = pagedata.data.query.pages[0].revisions.map((item) => item.user);

	const isCreator = editlist[0] === rootuser;
	const exuserlist = editlist.filter((element) => !maintainlist.includes(element) && element !== rootuser);

	return isCreator && exuserlist.length === 0;
}

async function pagedelete(pageid) {
	const result = await api.postWithToken('csrf', {
		action: 'delete',
		pageid,
		reason: '自动删除悬挂{{[[Template:ns2d|ns2d]]}}的用户页面',
		tags: 'Bot',
		watchlist: 'nochange',
	});
	console.log(result.data);
}

async function cannottdelete(pageid) {
	const content = await api.get({
		prop: 'revisions',
		pageids: pageid,
		rvprop: 'content',
	});
	let wikitext = content.data.query.pages[0].revisions[0].content;
	wikitext = wikitext.replace(/(?:<noinclude>\s*)?{{\s*(?:T:|模板:|[样樣]板:|Template:)?\s*ns2d\s*}}(?:\s*<\/noinclude>)?/gi, '');
	const result = await api.postWithToken('csrf', {
		action: 'edit',
		pageid,
		tags: 'Bot',
		watchlist: 'nochange',
		text: wikitext,
		minor: true,
		bot: true,
		summary: '无法自动删除，请至[[萌娘百科_talk:讨论版/操作申请]]提请维护人员删除。',
	});
	console.log(result.data);
}

api.login(config.abot.zh.name, config.abot.zh.password)
	.then(console.log, console.error)
	.then(async () => {
		const [usergroup, botlist] = await Promise.all([
			api.get({
				prop: 'revisions',
				titles: 'Module:UserGroup/data',
				rvprop: 'content',
			}),
			api.get({
				list: 'allusers',
				augroup: 'bot',
				aulimit: 'max',
			}),
		]);
		const { sysop, patroller, staff } = JSON.parse(
			usergroup.data.query.pages[0].revisions[0].content,
		);
		const bot = botlist.data.query.allusers.map((user) => user.name);
		const maintainlist = [...sysop, ...patroller, ...staff, ...bot];
		
		const data = await api.get({
			action: 'query',
			prop: 'transcludedin',
			titles: 'Template:Ns2d',
			tiprop: 'pageid|title',
			tinamespace: '2',
			tilimit: 'max',
		});
		const pagedata = data.data.query.pages[0];
		if (Object.prototype.hasOwnProperty.call(pagedata, 'transcludedin')){
			const pagelist = pagedata.transcludedin;
			console.log(pagedata);
			await Promise.all(
				pagelist.map(async (page) => {
					const { title, pageid } = page;
					if (await rule_test(title, pageid, maintainlist)) {
						await pagedelete(pageid);
					} else {
						await cannottdelete(pageid);
					}
				}),
			);
		} else {
			console.log('The pages that embed the {{ns2d}} do not exist currently.');
		}
		console.log(`End time: ${new Date().toISOString()}`);
	},
	);