import type { MediaWikiApi } from 'wiki-saikou';
import type { MwPageContentResponse } from '../types/mediawiki.d.ts';
import { createAndLogin } from '../utils/core/createApi.ts';
import { safePostWithToken } from '../utils/core/retry.ts';

const SITE_LIST = ['zh', 'cm'] as const;

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	const zhapi = await createAndLogin('zh', 'bot');

	const { data: { query: { pages: [{ revisions: [{ content }] }] } } } = await zhapi.post<MwPageContentResponse>({
		prop: 'revisions',
		titles: 'User:星海子/BotConfig/nulleditInCategory.json',
		rvprop: 'content',
	}, {
		retry: 15,
	});
	const setting = JSON.parse(content || '{}') as Record<'zh' | 'cm', string[]>;
	
	await Promise.all(
		SITE_LIST.map(async (site) => {
			const api: MediaWikiApi = site === 'zh' ? zhapi : await createAndLogin(site, 'bot');
			const queryCats = async (title: string): Promise<number[]> => {
				const { data: { query } } = await api.post<{
					query?: { pages: Array<{ pageid: number; categoryinfo: { size: number } }> };
				}>({
					prop: 'categoryinfo',
					generator: 'categorymembers',
					gcmtitle: `Category:${title}`,
					gcmprop: 'ids|title',
					gcmtype: 'subcat|page|file',
					gcmlimit: 'max',
				}, {
					retry: 15,
				});
				if (!query) {
					return [];
				}
				const queryPages = query.pages;
				switch (title) {
					case '尚未清空的已重定向分类':
					case '尚未清空的消歧义分类':
						return queryPages
							.filter(({ categoryinfo: { size } }) => size === 0)
							.map(({ pageid }) => pageid);
					default:
						return queryPages.map(({ pageid }) => pageid);
				}
			};
			
			const catlist = [...setting[site], '尚未清空的已重定向分类', '尚未清空的消歧义分类'];

			await Promise.all(
				catlist.map(async (title) => {
					const pagelist = await queryCats(title);

					if (pagelist.length) {
						await Promise.all(
							pagelist.map(async (pageid) => {
								await safePostWithToken(api, 'csrf', {
									action: 'edit',
									pageid,
									appendtext: '',
									minor: true,
									bot: true,
									nocreate: true,
									tags: 'Bot',
									summary: '空编辑以刷新分类表',
									watchlist: 'nochange',
								}, {
									retry: 50,
									noCache: true,
								});
							}),
						);
					} else {
						console.log(`Site:${site} Category:${title} is empty.`);
					}
				}),
			);
		}),
	);
	console.log(`End time: ${new Date().toISOString()}`);
})();