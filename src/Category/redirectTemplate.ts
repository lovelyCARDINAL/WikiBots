import { createAndLogin } from '../utils/core/createApi.ts';
import paginate from '../utils/core/paginate.ts';

const SITE_LIST = ['zh', 'cm'] as const;

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	await Promise.all(SITE_LIST.map(async (site) => {
		const api = await createAndLogin(site, 'bot');

		const categorymembers = await (async () => {
			const result: Array<{ pageid: number; title: string }> = [];
			for await (const data of paginate(api, {
				list: 'categorymembers',
				cmtitle: 'Category:已重定向的分类',
				cmprop: 'ids|title',
				cmnamespace: '14',
				cmlimit: 'max',
			})) {
				if (data.query?.categorymembers) {
					result.push(...data.query.categorymembers.filter((m): m is { pageid: number; title: string } => typeof m.pageid === 'number' && typeof m.title === 'string'));
				}
			}
			return result;
		})();

		const allredirects = await (async () => {
			const result: Array<{ fromid: number; title: string }> = [];
			for await (const data of paginate(api, {
				list: 'allredirects',
				arprop: 'title|ids',
				arnamespace: '14',
				arlimit: 'max',
			})) {
				if (data.query?.allredirects) {
					result.push(...data.query.allredirects.filter((r): r is { fromid: number; title: string } => typeof r.fromid === 'number' && typeof r.title === 'string'));
				}
			}
			return result;
		})();

		const pageids = allredirects
			.map(({ fromid }) => fromid)
			.filter((fromid) => !categorymembers
				.map(({ pageid }) => pageid)
				.some((pageid) => pageid === fromid));
		
		if (!pageids.length) {
			return;
		}

		interface RedirectTargetPage {
			title: string;
			redirects?: Array<{ ns: number; pageid: number }>;
		}
		const { data: { query: { pages } } } = await api.post<{
			query: { pages: RedirectTargetPage[] };
		}>({
			prop: 'redirects',
			pageids: pageids.map(String),
			redirects: true,
			rdprop: 'pageid|title',
			rdlimit: 'max',
		}, {
			retry: 15,
		});

		const result = pages.flatMap((item) => (item?.redirects ?? [])
			.filter((redirect) => redirect.ns === 14 && pageids.includes(redirect.pageid))
			.map((redirect): [number, string] => [redirect.pageid, item.title]),
		);
			
		await Promise.all(
			result.map(async ([pageid, target]) => {
				try {
					const { data } = await api.postWithToken('csrf', {
						action: 'edit',
						pageid,
						text: `#Redirect [[:${target}]]\n{{Cr|${target.replace('Category:', '')}}}`,
						minor: true,
						bot: true,
						nocreate: true,
						tags: 'Bot',
						summary: `添加至「[[:${target}]]」的[[Template:分类重定向|分类重定向]]`,
						watchlist: 'nochange',
					}, {
						retry: 50,
						noCache: true,
					});
					console.log(JSON.stringify(data));
					if (data?.edit?.result && data.edit.result !== 'Success') {
						console.error(`${site} ${pageid} 编辑未成功:`, JSON.stringify(data));
						process.exitCode = 1;
					}
				} catch (error) {
					console.error(`${site} ${pageid} 编辑失败:`, error instanceof Error ? error.message : String(error));
					process.exitCode = 1;
				}
			}),
		);
	}));
	console.log(`End time: ${new Date().toISOString()}`);
})();
