import moment from 'moment';
import type { MediaWikiApi } from 'wiki-saikou';
import type { MwQueryResponse } from '../types/mediawiki.d.ts';
import { createAndLogin } from '../utils/createApi.ts';
import { safePostWithToken } from '../utils/retry.ts';

async function queryPages(api: MediaWikiApi, apprefix: string, apprtype?: string, apprlevel?: string): Promise<Array<{ pageid: number; title: string }>> {
	const { data: { query: { allpages } } } = await api.post<MwQueryResponse<{
		allpages: Array<{ pageid: number; title: string }>;
	}>>({
		list: 'allpages',
		aplimit: 'max',
		apnamespace: '4',
		apprefix,
		apprtype,
		apprlevel,
	}, {
		retry: 15,
	});
	return allpages;
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	const api = await createAndLogin('zh', 'abot');

	const prefixlist = ['萌娘百科月报/20', '萌娘百科月报/月饼/20'];
	const currentDate = moment().format('YYYY年M月');
	const filteredPagelist = (await Promise.all(
		prefixlist.map(
			async (prefix) => {
				const pages = await queryPages(api, prefix);
				const pagesWithPr = await queryPages(api, prefix, 'edit', 'patrolleredit');
				const diff = pages.filter((itemA) => !pagesWithPr.some((itemB) => itemA.pageid === itemB.pageid));
				return diff.map((item) => item.title);
			},
		),
	)).flat().filter((item) => !item.includes(currentDate));

	if (filteredPagelist.length) {
		await Promise.all(
			filteredPagelist.map(async (title) => {
				await safePostWithToken(api, 'csrf', {
					action: 'protect',
					title,
					protections: 'edit=patrolleredit|move=sysop',
					expiry: 'infinite',
					reason: '月报存档',
					tags: 'Bot',
					watchlist: 'nochange',
				}, {
					retry: 50,
					noCache: true,
				});
			}),
		);
	} else {
		console.log('No page to protect.');
	}

	console.log(`End time: ${new Date().toISOString()}`);
})();