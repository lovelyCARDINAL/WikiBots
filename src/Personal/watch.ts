import moment from 'moment';
import type { MediaWikiApi } from 'wiki-saikou';
import splitAndJoin from '../utils/common/splitAndJoin.ts';
import { createAndLogin } from '../utils/core/createApi.ts';
import { safePostWithToken } from '../utils/core/retry.ts';

async function watch(api: MediaWikiApi, titles: string, unwatch = false) {
	await safePostWithToken(api, 'watch', {
		action: 'watch',
		titles,
		unwatch,
	}, {
		retry: 50,
		noCache: true,
	});
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	const api = await createAndLogin('zh', 'main');

	let watchlist = await (async () => {
		const { data: { query: { allusers } } } = await api.post<{
			query: { allusers: Array<{ name: string }> };
		}>({
			list: 'allusers',
			augroup: ['sysop', 'bot', 'patroller', 'staff', 'techeditor', 'interface-admin'],
			aulimit: 'max',
		}, {
			retry: 15,
		});
		return allusers.map(({ name }) => `User:${name}`);
	})();

	const { data: { query: { categorymembers } } } = await api.post<{
		query: { categorymembers: Array<{ title: string }> };
	}>({
		list: 'categorymembers',
		cmpageid: '374746',
		cmprop: 'title',
		cmnamespace: '*',
		cmlimit: 'max',
	}, {
		retry: 15,
	});
	watchlist.push(...categorymembers.map((member) => member.title));

	watchlist = splitAndJoin(watchlist, 50);
	await Promise.all(
		watchlist.map(
			(result) => watch(api, result),
		),
	);

	if (moment().utc().format('dddd') === 'Sunday') {
		const { data: { watchlistraw: talklist } } = await api.post<{
			watchlistraw: Array<{ title: string }>;
		}>({
			list: 'watchlistraw',
			wrnamespace: '5',
			wrlimit: 'max',
			wrfromtitle: '萌娘百科_talk:讨论版',
			wrtotitle: '萌娘百科_talk:讨论页面',
		}, {
			retry: 15,
		});
		const unwatchlist = splitAndJoin(
			talklist
				.filter((member) => member.title.includes('存档'))
				.map((member) => member.title),
			50,
		);
		await Promise.all(
			unwatchlist.map(
				(result) => watch(api, result, true),
			),
		);
	}
	console.log(`End time: ${new Date().toISOString()}`);
})();