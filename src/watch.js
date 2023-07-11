import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';
import moment from 'moment';
import splitAndJoin from './utils/commonOperations.js';

const api = new MediaWikiApi(config.api.zh, {
	headers: {
		'api-user-agent': config.apiuseragent || '',
	},
});

async function watch(titles, unwatch) {
	const result = await api.postWithToken('watch', {
		action: 'watch',
		titles,
		...unwatch && { unwatch },
	});
	console.log(result.data);
}

console.log(`Start time: ${ new Date().toISOString()}`);

api.login(config.main.zh.name, config.main.zh.password)
	.then(console.log, console.error)
	.then(async () => {
		const usergroup = await api.get({
			prop: 'revisions',
			titles: 'Module:UserGroup/data',
			rvprop: 'content',
		});
		const { sysop, patroller, techeditor, staff } = JSON.parse(
			usergroup.data.query.pages[0].revisions[0].content,
		);
		let watchlist = [...sysop, ...patroller, ...techeditor, ...staff]
			.map((username) => `User:${username}`,
			);

		const catlist = await api.get({
			list: 'categorymembers',
			cmpageid: '374746',
			cmprop: 'title',
			cmnamespace: '*',
			cmlimit: 'max',
		});
		watchlist.push(
			...catlist.data.query.categorymembers
				.map((member) => member.title),
		);

		watchlist = splitAndJoin(watchlist, 50);
		for (const result of watchlist) {
			await watch(result);
		}

		if (moment().utc().format('dddd') === 'Sunday') {
			const talklist = await api.get({
				list: 'watchlistraw',
				wrnamespace: '5',
				wrlimit: 'max',
				wrfromtitle: '萌娘百科_talk:讨论版',
				wrtotitle: '萌娘百科_talk:讨论页面',
			});
			const unwatchlist = splitAndJoin(
				talklist.data.watchlistraw
					.filter((member) => member.title.includes('存档'))
					.map((member) => member.title)
				, 50);
			for (const result of unwatchlist) {
				await watch(result, true);
			}
		}
		console.log(`End time: ${new Date().toISOString()}`);
	});