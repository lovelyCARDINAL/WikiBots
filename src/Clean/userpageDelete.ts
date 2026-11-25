
import type { MediaWikiApi } from 'wiki-saikou';
import type { MwAllUser, MwPageContentResponse, MwQueryResponse } from '../types/mediawiki.d.ts';
import { createAndLogin } from '../utils/createApi.ts';
import { safePostWithToken } from '../utils/retry.ts';

async function ruleTest(api: MediaWikiApi, title: string, pageid: number, maintainlist: string[]): Promise<boolean> {
	const rootuser = title.replace(/^User:(.+?)(?:\/.*)?$/, '$1');

	const { data: { query: { pages } } } = await api.post<MwQueryResponse<{
		pages: Array<{ revisions: Array<{ user: string }> }>;
	}>>({
		prop: 'revisions',
		pageids: pageid,
		rvprop: 'user',
		rvlimit: 'max',
		rvdir: 'newer',
	}, {
		retry: 15,
	});
	const editlist: string[] = pages[0].revisions.map((item) => item.user);

	const isCreator = editlist[0] === rootuser;
	const exuserlist = editlist.filter((element) => !maintainlist.includes(element) && element !== rootuser);

	return isCreator && exuserlist.length === 0;
}

async function pageDelete(api: MediaWikiApi, pageid: number) {
	await safePostWithToken(api, 'csrf', {
		action: 'delete',
		pageid,
		reason: '自动删除悬挂{{[[Template:ns2d|ns2d]]}}的用户页面',
		tags: 'Bot',
		watchlist: 'nochange',
	}, {
		retry: 50,
		noCache: true,
	});
}

async function cannotDelete(api: MediaWikiApi, pageid: number) {
	const { data: { query: { pages } } } = await api.post<MwPageContentResponse>({
		prop: 'revisions',
		pageids: pageid,
		rvprop: 'content',
	}, {
		retry: 15,
	});
	let wikitext = pages[0].revisions[0].content;
	wikitext = wikitext.replaceAll(/(?:<noinclude>\s*)?{{\s*(?:T:|模板:|[样樣]板:|Template:)?\s*ns2d\s*}}(?:\s*<\/noinclude>)?/gi, '');
	await safePostWithToken(api, 'csrf', {
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
	});
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	const api = await createAndLogin('zh', 'abot');

	const maintainlist = await (async () => {
		const { data: { query: { allusers } } } = await api.post<MwQueryResponse<{ allusers: MwAllUser[] }>>({
			list: 'allusers',
			augroup: ['sysop', 'bot', 'patroller', 'staff'],
			aulimit: 'max',
		}, {
			retry: 15,
		});
		return allusers.map(({ name }) => name);
	})();
		
	const { data } = await api.post<MwQueryResponse<{
		pages: Array<{ transcludedin?: Array<{ title: string; pageid: number }> }>;
	}>>({
		prop: 'transcludedin',
		titles: 'Template:Ns2d',
		tiprop: 'pageid|title',
		tinamespace: '2',
		tilimit: 'max',
	}, {
		retry: 15,
	});
	const pagedata = data.query.pages[0];
	if (pagedata.transcludedin) {
		const pagelist = pagedata.transcludedin;
		await Promise.all(
			pagelist.map(async (page) => {
				const { title, pageid } = page;
				if (await ruleTest(api, title, pageid, maintainlist)) {
					await pageDelete(api, pageid);
				} else {
					await cannotDelete(api, pageid);
				}
			}),
		);
	} else {
		console.log('The pages that embed the {{ns2d}} do not exist currently.');
	}
	
	console.log(`End time: ${new Date().toISOString()}`);
})();