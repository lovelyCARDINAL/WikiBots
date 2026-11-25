import type { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import type { MwQueryResponse } from '../types/mediawiki.d.ts';
import splitAndJoin from '../utils/common/splitAndJoin.ts';
import { createAndLogin } from '../utils/core/createApi.ts';
import { safePostWithToken } from '../utils/core/retry.ts';

Parser.config = 'moegirl';

async function querySearch(api: MediaWikiApi, srsearch: string) {
	const { data: { query: { search } } } = await api.post<MwQueryResponse<{
		search: Array<{ title: string; pageid: number }>;
	}>>({
		list: 'search',
		srsearch,
		srnamespace: '10',
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

	const search = await Promise.all([
		querySearch(api, 'hastemplate:"navbox" insource:"name" insource:"navbox"'),
		querySearch(api, 'insource:"invoke:nav" insource:"name"'),
		querySearch(api, 'hastemplate:"大家族" insource:"name" insource:"大家族"'),
	]).then((result) => result.flat());

	const ids = search
		.filter(({ title }) => !/Template:(?:Navbox|大家族|沙盒|Sandbox)|\/doc/.test(title))
		.map(({ pageid }) => pageid);
	const idslist = splitAndJoin([...new Set(ids)], 500);

	await Promise.all(idslist.map(async (pageids) => {
		const { data: { query: { pages } } } = await api.post<{
			query: { pages: Array<{ title: string; revisions: Array<{ content: string }> }> };
		}>({
			prop: 'revisions',
			pageids,
			rvprop: 'content',
		}, {
			retry: 25,
		});
		await Promise.all(pages.map(async ({ title, revisions: [{ content }] }) => {
			const wikitext = Parser.parse(content, true);
			const navToken = wikitext.querySelector<Parser.TranscludeToken>('template:regex("name, /^Template:(?:Navbox(?:_with_collapsible_groups|_with_columns)?|大家族(?:模板)?)$/i"), magic-word#invoke[module=Module:Nav]');
			const name = navToken?.getValue('name')?.trim();
			if (!name) {
				console.log(`${title} 找不到navbox或缺失name参数。`);
				return;
			}
			const value = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
			const titleValue = title.replace('Template:', '');
			if (value.replaceAll('_', ' ') !== titleValue) {
				const regex = new RegExp(`(\\|\\s*name\\s*=\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
				await safePostWithToken(api, 'csrf', {
					action: 'edit',
					title,
					text: content.replace(regex, `$1${titleValue}`),
					bot: true,
					tags: 'Bot',
					watchlist: 'nochange',
					summary: `修复Navbox模板name参数：${name} → ${titleValue}`,
				}, {
					retry: 50,
					noCache: true,
				});
			}
		}));
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();
