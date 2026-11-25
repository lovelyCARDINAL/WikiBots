import type { MwPageContentResponse } from '../types/mediawiki.d.ts';
import { createAndLogin } from '../utils/createApi.ts';

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	const api = await createAndLogin('zh', 'abot');

	const { data: { query: { pages: [{ revisions: [{ content }] }] } } } = await api.post<MwPageContentResponse>({
		prop: 'revisions',
		titles: 'User:星海子/BotConfig/purge.json',
		rvprop: 'content',
	}, {
		retry: 15,
	});
	const setting = JSON.parse(content || '{}') as {
		group: Array<{ prefix: string; ns: string }>;
		page: string[];
	};

	await Promise.all([
		Promise.all(setting.group.map(async ({ prefix, ns }) => {
			await api.post({
				action: 'purge',
				generator: 'allpages',
				gapprefix: prefix,
				gapnamespace: ns,
				gaplimit: 'max',
			}, {
				retry: 15,
			}).then(({ data }) => console.log(JSON.stringify(data)));
		})),
		api.post({
			action: 'purge',
			titles: setting.page,
		}, {
			retry: 15,
		}).then(({ data }) => console.log(JSON.stringify(data))),
	]);

	console.log(`End time: ${new Date().toISOString()}`);
})();