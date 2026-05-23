import { MediaWikiApi } from 'wiki-saikou';
import config from '../utils/config.js';

const api = new MediaWikiApi({
	baseURL: config.zh.api,
	fexiosConfig: {
		headers: { 'user-agent': config.useragent },
	},
});

(async () => {
	try {
		const loginResult = await api.login(
			config.zh.bot.name,
			config.zh.bot.password,
			undefined,
			{ retry: 25, noCache: true },
		);
		console.log(loginResult);

		const editResult = await api.postWithToken('csrf', {
			action: 'edit',
			title: 'User:星海子/test/001',
			text: `${new Date().toISOString()}`,
			summary: 'Test',
			bot: true,
			minor: true,
			tags: 'Bot',
		}, {
			retry: 50,
			noCache: true,
		});
		console.log(JSON.stringify(editResult.data));

	} catch (error) {
		console.error(error);
	}
})();
