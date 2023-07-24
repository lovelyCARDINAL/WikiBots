import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';

const api = new MediaWikiApi(config.zh.api, { headers: { 'api-user-agent': config.apiuseragent } });

console.log(`Start time: ${new Date().toISOString()}`);

(async () => {
	await api.login(config.zh.bot.name, config.zh.bot.password).then(console.log);

	const { data } = await api.postWithToken('csrf', {
		action: 'edit',
		title: 'User:星海子/test/001',
		text: `${new Date().toISOString()}`,
		summary: 'Github Actions Test',
		bot: true,
		minor: true,
		tags: 'Bot',
	});
	console.log(JSON.stringify(data));
})();
