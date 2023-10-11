import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';

const api = new MediaWikiApi(config.zh.api, {
	headers: { 'api-user-agent': config.apiuseragent },
});

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	await api.login(
		config.zh.bot.name,
		config.zh.bot.password,
		undefined,
		{ retry: 25, noCache: true },
	).then(console.log);

	/*await api.postWithToken('csrf', {
		action: 'edit',
		title: 'User:星海子/test/001',
		text: `${new Date().toISOString()}`,
		summary: 'Github Actions Test',
		bot: true,
		minor: true,
		tags: 'Bot',
	}, {
		retry: 50,
		noCache: true,
	}).then(({ data }) => console.log(JSON.stringify(data)));*/

	console.log(
		'%cTEST%c',
		'color: #3c89e8; padding: 1px 5px; border-radius: 4px; border: 1px solid #91caff;',
		null,
		'\x1b[31mThis is red text\x1b[0m',
	);
})();
