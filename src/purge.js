import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';

const api = new MediaWikiApi(config.zh.api, {
	headers: { 'api-user-agent': config.apiuseragent },
});

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	await api.login(
		config.zh.abot.name,
		config.zh.abot.password,
		undefined,
		{ retry: 25, noCache: true },
	).then(console.log);

	const { data: { query: { pages: [{ revisions: [{ content }] }] } } } = await api.post({
		prop: 'revisions',
		titles: 'User:星海子/BotConfig/purge.json',
		rvprop: 'content',
	});
	const setting = JSON.parse(content || '{}');

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