import { MediaWikiApi } from 'wiki-saikou';
import config from '../utils/config.js';

const api = new MediaWikiApi(config.zh.api, {
	headers: { 'user-agent': config.useragent },
});

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	await api.login(
		config.zh.abot.name,
		config.zh.abot.password,
		undefined,
		{ retry: 25, noCache: true },
	).then(console.log);
		
	const { data: { query: { querypage: { results } } } } = await api.post({
		list: 'querypage',
		qppage: 'BrokenRedirects',
		qplimit: 'max',
	}, {
		retry: 15,
	});
	if (results.length) {
		await Promise.all(results.map(async (item) => {
			if (item.ns === 2 || item.title % 2 === 1) {
				await api.postWithToken('csrf', {
					action: 'delete',
					title: item.title,
					reason: '受损重定向',
					tags: 'Bot',
					watchlist: 'nochange',
				}, {
					retry: 50,
					noCache: true,
				}).then(({ data }) => console.log(JSON.stringify(data)));
			}
		}));
	} else {
		console.log('No broken redirect.');
	}
	console.log(`End time: ${new Date().toISOString()}`);
})();
