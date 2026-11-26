import process from 'process';
import { MediaWikiApi } from 'wiki-saikou';
import config from '../utils/config.ts';

const api = new MediaWikiApi({
	baseURL: config.valorant.api,
	fexiosConfigs: {
		headers: {
			cookie: 'SESSDATA=INVALID',
			'user-agent': config.useragent,
		},
	},
});

async function pageDelete(pageid: number): Promise<void> {
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

	if (!config.valorant.bot.password) {
		throw new Error('Missing BWIKI_VALORANT_BOT');
	}

	await api.login(
		config.valorant.bot.name,
		config.valorant.bot.password,
		undefined,
		{ retry: 25, noCache: true },
	).then(console.log);

	const { data } = await api.post<{
		query?: { pages?: Array<{ transcludedin?: Array<{ pageid: number }> }> };
	}>({
		prop: 'transcludedin',
		titles: 'Template:Ns2d',
		tiprop: 'pageid',
		tinamespace: '2',
		tilimit: 'max',
	}, {
		retry: 15,
	});

	const pageids = (data?.query?.pages?.[0]?.transcludedin ?? []).map(({ pageid }) => pageid);
	if (pageids.length === 0) {
		console.log('The pages that embed the {{ns2d}} do not exist currently.');
	} else {
		const results = await Promise.allSettled(pageids.map(pageDelete));
		for (const res of results) {
			if (res.status === 'rejected') {
				console.error('Failed to delete page:', res.reason instanceof Error ? res.reason.message : String(res.reason));
				process.exitCode = 1;
			}
		}
	}

	console.log(`End time: ${new Date().toISOString()}`);
})();
