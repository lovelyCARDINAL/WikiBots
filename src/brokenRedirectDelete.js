import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';

const api = new MediaWikiApi(config.zh.api, { headers: { 'api-user-agent': config.apiuseragent } });

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	await api.login(config.zh.abot.name, config.zh.abot.password).then(console.log);
		
	const { data :{ query: { querypage: { results } } } } = await api.post({
		list: 'querypage',
		qppage: 'BrokenRedirects',
		qplimit: 'max',
	});
	if (results.length) {
		await Promise.all(results.map(async (item) => {
			if (item.ns === 2 || item.title % 2 === 1) {
				const { data } = await api.postWithToken('csrf', {
					action: 'delete',
					title: item.title,
					reason: '受损重定向',
					tags: 'Bot',
					watchlist: 'nochange',
				});
				console.log(JSON.stringify(data));
			}
		}));
	} else {
		console.log('No broken redirect.');
	}
	console.log(`End time: ${new Date().toISOString()}`);
})();
