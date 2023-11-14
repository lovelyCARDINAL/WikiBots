import moment from 'moment';
import { MediaWikiApi } from 'wiki-saikou';
import config from '../utils/config.js';
import splitAndJoin from '../utils/splitAndJoin.js';

const api = new MediaWikiApi(config.zh.api, {
	headers: { 'user-agent': config.useragent },
});

async function watch(titles, unwatch) {
	await api.postWithToken('watch', {
		action: 'watch',
		titles,
		unwatch,
	}, {
		retry: 50,
		noCache: true,
	}).then(({ data }) => console.log(JSON.stringify(data)));
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	await api.login(
		config.zh.main.name,
		config.zh.main.password,
		undefined,
		{ retry: 25, noCache: true },
	).then(console.log);

	let watchlist = await (async () => {
		const { data: { query: { allusers } } } = await api.post({
			list: 'allusers',
			augroup: ['sysop', 'bot', 'patroller', 'staff', 'techeditor', 'interface-admin'],
			aulimit: 'max',
		}, {
			retry: 15,
		});
		return allusers.map(({ name }) => `User:${name}`);
	})();

	const { data: { query: { categorymembers } } } = await api.post({
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
			(result) => watch(result),
		),
	);

	if (moment().utc().format('dddd') === 'Sunday') {
		const { data: { watchlistraw: talklist } } = await api.post({
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
				.map((member) => member.title)
			, 50);
		await Promise.all(
			unwatchlist.map(
				(result) => watch(result, true),
			),
		);
	}
	console.log(`End time: ${new Date().toISOString()}`);
})();