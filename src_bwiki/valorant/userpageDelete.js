import { MediaWikiApi } from 'wiki-saikou';
import config from '../utils/config.js';

const api = new MediaWikiApi(config.valorant.api, {
	headers: { cookie: 'SESSDATA=INVALID' },
});

async function pageDelete(pageid) {
	const { data } = await api.postWithToken('csrf', {
		action: 'delete',
		pageid,
		reason: '自动删除悬挂{{[[Template:ns2d|ns2d]]}}的用户页面',
		tags: 'Bot',
		watchlist: 'nochange',
	}, {
		retry: 50,
		noCache: true,
	});
	console.log(JSON.stringify(data));
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	await api.login(
		config.valorant.account,
		config.valorant.password,
		undefined,
		{ retry: 25, noCache: true },
	).then(console.log);
		
	const { data: { query: { pages: [{ transcludedin: data }] } } } = await api.post({
		prop: 'transcludedin',
		titles: 'Template:Ns2d',
		tiprop: 'pageid',
		tinamespace: '2',
		tilimit: 'max',
	}, {
		retry: 15,
	});
	const pageids = (data || []).map(({ pageid }) => pageid);
	if (pageids.length === 0) {
		console.log('The pages that embed the {{ns2d}} do not exist currently.');
	} else {
		await Promise.allSettled(pageids.map(pageDelete));
	}
	
	console.log(`End time: ${new Date().toISOString()}`);
})();