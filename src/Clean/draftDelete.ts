import type { MediaWikiApi } from 'wiki-saikou';
import type { MwAllUser, MwQueryResponse } from '../types/mediawiki.d.ts';
import { createAndLogin } from '../utils/core/createApi.ts';
import { deletePageById, removeDeletionTemplate } from '../utils/wiki/deletePage.ts';

async function ruleTest(api: MediaWikiApi, pageid: number, maintainlist: string[]): Promise<boolean> {
	const { data } = await api.post<MwQueryResponse<{
		pages?: Array<{ revisions?: Array<{ user: string }> }>;
	}>>({
		prop: 'revisions',
		pageids: pageid,
		rvprop: 'user',
		rvlimit: 'max',
		rvdir: 'newer',
	}, {
		retry: 15,
	});
	const revisions = data?.query?.pages?.[0]?.revisions;
	if (!revisions?.length) {
		return false;
	}
	const editlist: string[] = revisions.map((item) => item.user);
	const creator = editlist[0];
	const exuserlist = editlist.filter((element) => !maintainlist.includes(element) && element !== creator);

	return exuserlist.length === 0;
}

async function pageDelete(api: MediaWikiApi, pageid: number) {
	await deletePageById(api, pageid, '自动删除悬挂{{[[Template:nsdd|nsdd]]}}的草稿页面');
}

async function cannotDelete(api: MediaWikiApi, pageid: number) {
	await removeDeletionTemplate(
		api,
		pageid,
		/(?:<noinclude>\s*)?{{\s*(?:T:|模板:|[样樣]板:|Template:)?\s*nsdd\s*}}(?:\s*<\/noinclude>)?/gi,
	);
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	const api = await createAndLogin('zh', 'abot');

	const maintainlist = await (async () => {
		const { data } = await api.post<MwQueryResponse<{ allusers?: MwAllUser[] }>>({
			list: 'allusers',
			augroup: ['bot'],
			aulimit: 'max',
		}, {
			retry: 15,
		});
		return (data?.query?.allusers ?? []).map(({ name }) => name);
	})();

	const { data } = await api.post<MwQueryResponse<{
		pages?: Array<{ transcludedin?: Array<{ pageid: number }> }>;
	}>>({
		prop: 'transcludedin',
		titles: 'Template:Nsdd',
		tiprop: 'pageid',
		tinamespace: '118',
		tilimit: 'max',
	}, {
		retry: 15,
	});
	const pagelist = data?.query?.pages?.[0]?.transcludedin;
	if (pagelist?.length) {
		await Promise.all(
			pagelist.map(async (page) => {
				const { pageid } = page;
				if (await ruleTest(api, pageid, maintainlist)) {
					await pageDelete(api, pageid);
				} else {
					await cannotDelete(api, pageid);
				}
			}),
		);
	} else {
		console.log('The pages that embed the {{nsdd}} do not exist currently.');
	}
	
	console.log(`End time: ${new Date().toISOString()}`);
})();
