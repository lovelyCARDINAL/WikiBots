import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';

const SITE_LIST = ['zh', 'cm'];

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	await Promise.all(SITE_LIST.map(async (site) => {
		const api = new MediaWikiApi(config[site].api, {
			headers: { 'api-user-agent': config.apiuseragent },
		});
		await api.login(
			config[site].bot.name,
			config[site].bot.password,
			undefined,
			{ retry: 25, noCache: true },
		).then(console.log);

		const { data: { query: { allredirects, categorymembers } } } = await api.post({
			list: 'allredirects|categorymembers',
			cmtitle: 'Category:已重定向的分类',
			cmprop: 'ids|title',
			cmnamespace: '14',
			cmlimit: 'max',
			arprop: 'title|ids',
			arnamespace: '14',
			arlimit: 'max',
		}, {
			retry: 15,
		});

		const pageids = allredirects
			.map(({ fromid }) => fromid)
			.filter((fromid) => !categorymembers
				.map(({ pageid }) => pageid)
				.some((pageid) => pageid === fromid));
		
		if (!pageids.length) {
			return;
		}

		const { data: { query: { pages } } } = await api.post({
			prop: 'redirects',
			pageids,
			redirects: true,
			rdprop: 'pageid|title',
			rdlimit: 'max',
		}, {
			retry: 15,
		});

		const result = pages.map((item) => item?.redirects
			.filter((redirect) => redirect.ns === 14 && pageids.includes(redirect.pageid))
			.flatMap((redirect) => [redirect.pageid, item.title]),
		).filter((arr) => arr.length);
			
		await Promise.all(
			result.map(async ([pageid, target]) => {
				await api.postWithToken('csrf', {
					action: 'edit',
					pageid,
					appendtext: `\n{{Cr|${target.replace('Category:', '')}}}`,
					minor: true,
					bot: true,
					nocreate: true,
					tags: 'Bot',
					summary: `添加至「[[:${target}]]」的[[Template:分类重定向|分类重定向]]`,
					watchlist: 'nochange',
				}, {
					retry: 50,
					noCache: true,
				}).then(({ data }) => console.log(JSON.stringify(data)));
			}),
		);
	}));
	console.log(`End time: ${new Date().toISOString()}`);
})();
