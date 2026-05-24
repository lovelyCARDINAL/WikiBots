import { MediaWikiApi } from 'wiki-saikou';
import config from '../utils/config.js';

const api = new MediaWikiApi('https://zh.moegirl.org.cn/api.php');

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	await api.post({
		action: 'query',
		meta: 'siteinfo',
	}, {
		retry: 5,
		noCache: true,
	}).then(({ data }) => console.log(JSON.stringify(data)));
	
	await api.login(
		config.zh.bot.name,
		config.zh.bot.password,
	).then(console.log);

	await api.postWithToken('csrf', {
		action: 'edit',
		title: 'User:星海子/test/001',
		text: `${new Date().toISOString()}`,
		summary: 'Github Actions Test',
		bot: true,
		minor: true,
		tags: 'Bot',
	}, {
		retry: 5,
		noCache: true,
	}).then(({ data }) => console.log(JSON.stringify(data)));
})();
