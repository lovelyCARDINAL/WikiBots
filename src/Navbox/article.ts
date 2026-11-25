import type { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import type { MwQueryResponse } from '../types/mediawiki.d.ts';
import { createAndLogin } from '../utils/createApi.ts';
import { safePostWithToken } from '../utils/retry.ts';

Parser.config = 'moegirl';

async function querySearch(api: MediaWikiApi, srsearch: string): Promise<Array<{ pageid: number }>> {
	const { data: { query: { search } } } = await api.post<MwQueryResponse<{
		search: Array<{ pageid: number }>;
	}>>({
		list: 'search',
		srsearch,
		srnamespace: '0|4|12',
		srlimit: 'max',
		srinfo: '',
		srprop: '',
	}, {
		retry: 25,
	});
	return search;
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	const api = await createAndLogin('zh', 'ibot');

	const pageids = await Promise.all([
		querySearch(api, 'hastemplate:"navbox" insource:"navbox"'),
		querySearch(api, 'insource:"invoke:nav"'),
		querySearch(api, 'insource:"大家族" hastemplate:"大家族"'),
	]).then((result) => result.flat().map(({ pageid }) => pageid));

	const { data: { query: { pages } } } = await api.post<{
		query: { pages: Array<{ title: string; revisions: Array<{ content: string }> }> };
	}>({
		prop: 'revisions',
		pageids: pageids.map(String),
		rvprop: 'content',
	}, {
		retry: 25,
	});
	const navdata = new Set<[string, string | undefined]>();

	await Promise.all(pages.map(({ title, revisions: [{ content }] }) => {
		const wikitext = Parser.parse(content, true);
		const template = wikitext.querySelector<Parser.TranscludeToken>('template:regex("name, /^Template:(?:Navbox(?:_with_collapsible_groups|_with_columns)?|大家族(?:模板)?)$/i"), magic-word#invoke[module=Module:Nav]');
		if (template) {
			const name = template.getValue('name')?.trim();
			const talkpage = Parser.normalizeTitle(title).toTalkPage().title;
			navdata.add([talkpage, name]);
		}
	}));

	const talkpages = await api.post<{
		query: { categorymembers: Array<{ title: string }> };
	}>({
		list: 'categorymembers',
		cmtitle: 'Category:页面中存在错误的大家族模板',
		cmlimit: 'max',
		cmprop: '',
	}, {
		retry: 25,
	}).then(({ data: { query: { categorymembers } } }) => categorymembers.map(({ title }) => title));

	for (const data of navdata) {
		if (data[0] in talkpages || data[0] === 'Help talk:常用模板') {
			navdata.delete(data);
		}
	}
	
	await Promise.all([...navdata].map(async ([title, name]) => {
		await safePostWithToken(api, 'csrf', {
			action: 'edit',
			title,
			prependtext: `{{warn navbox|name=${name}}}\n\n`,
			summary: '提醒页面中存在错误的大家族模板',
			notminor: true,
			bot: true,
			tags: 'Bot',
			watchlist: 'nochange',
		}, {
			retry: 50,
			noCache: true,
		});
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();
