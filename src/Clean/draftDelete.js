import { MediaWikiApi } from 'wiki-saikou';
import config from '../utils/config.js';

const api = new MediaWikiApi({
	baseURL: config.zh.api,
	fexiosConfigs: {
		headers: { 'user-agent': config.useragent },
	},
});

async function ruleTest(pageid, maintainlist) {
	const { data: { query: { pages } } } = await api.post({
		prop: 'revisions',
		pageids: pageid,
		rvprop: 'user',
		rvlimit: 'max',
		rvdir: 'newer',
	}, {
		retry: 15,
	});
	const editlist = pages[0].revisions.map((item) => item.user);
	const creator = editlist[0];
	const exuserlist = editlist.filter((element) => !maintainlist.includes(element) && element !== creator);

	return exuserlist.length === 0;
}

async function pageDelete(pageid) {
	const { data } = await api.postWithToken('csrf', {
		action: 'delete',
		pageid,
		reason: '自动删除悬挂{{[[Template:nsdd|nsdd]]}}的草稿页面',
		tags: 'Bot',
		watchlist: 'nochange',
	}, {
		retry: 50,
		noCache: true,
	});
	console.log(JSON.stringify(data));
}

async function cannotDelete(pageid) {
	const { data: { query: { pages } } } = await api.post({
		prop: 'revisions',
		pageids: pageid,
		rvprop: 'content',
	}, {
		retry: 15,
	});
	let wikitext = pages[0].revisions[0].content;
	wikitext = wikitext.replaceAll(/(?:<noinclude>\s*)?{{\s*(?:T:|模板:|[样樣]板:|Template:)?\s*nsdd\s*}}(?:\s*<\/noinclude>)?/gi, '');
	await api.postWithToken('csrf', {
		action: 'edit',
		pageid,
		tags: 'Bot',
		watchlist: 'nochange',
		text: wikitext,
		minor: true,
		bot: true,
		summary: '无法自动删除，请至[[萌娘百科_talk:讨论版/操作申请]]提请维护人员删除。',
	}, {
		retry: 50,
		noCache: true,
	}).then(({ data }) => console.log(JSON.stringify(data)));
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	await api.login(
		config.zh.abot.name,
		config.zh.abot.password,
		undefined,
		{ retry: 25, noCache: true },
	).then(console.log);

	const maintainlist = await (async () => {
		const { data: { query: { allusers } } } = await api.post({
			list: 'allusers',
			augroup: ['bot'],
			aulimit: 'max',
		}, {
			retry: 15,
		});
		return allusers.map(({ name }) => name);
	})();
		
	const { data } = await api.post({
		prop: 'transcludedin',
		titles: 'Template:Nsdd',
		tiprop: 'pageid',
		tinamespace: '118',
		tilimit: 'max',
	}, {
		retry: 15,
	});
	const pagedata = data.query.pages[0];
	if (Object.prototype.hasOwnProperty.call(pagedata, 'transcludedin')){
		const pagelist = pagedata.transcludedin;
		await Promise.all(
			pagelist.map(async (page) => {
				const { pageid } = page;
				await ruleTest(pageid, maintainlist) ? await pageDelete(pageid) : await cannotDelete(pageid);
			}),
		);
	} else {
		console.log('The pages that embed the {{nsdd}} do not exist currently.');
	}
	
	console.log(`End time: ${new Date().toISOString()}`);
})();
