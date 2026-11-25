import mapLimit from '../utils/concurrency.js';
import { createAndLogin } from '../utils/createApi.js';
import { safePostWithToken } from '../utils/retry.js';

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	const api = await createAndLogin('zh', 'abot');
		
	const { data: { query: { querypage: { results } } } } = await api.post({
		list: 'querypage',
		qppage: 'BrokenRedirects',
		qplimit: 'max',
	}, {
		retry: 15,
	});
	if (results.length) {
		await mapLimit(results, 5, async (item) => {
			if (item.ns === 2 || item.title % 2 === 1) {
				await safePostWithToken(api, 'csrf', {
					action: 'delete',
					title: item.title,
					reason: '受损重定向',
					tags: 'Bot',
					watchlist: 'nochange',
				}, {
					retry: 50,
					noCache: true,
				});
			}
		});
	} else {
		console.log('No broken redirect.');
	}
	console.log(`End time: ${new Date().toISOString()}`);
})();
