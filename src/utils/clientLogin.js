import config from './config.js';

/**
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {string} username
 * @param {string} [password=config.password]
 */
async function clientLogin(api, username, password = config.password) {
	try {
		const { data } = await api.postWithToken(
			'login',
			{
				action: 'clientlogin',
				username,
				password,
				loginreturnurl: config.zh.api,
			},
			{
				tokenName: 'logintoken',
				retry: 15,
				noCache: true,
			},
		);
		if (data.clientlogin?.status === 'PASS') {
			console.log('登录成功', data.clientlogin.username);
			return data;
		}
		throw new Error(data.clientlogin?.message || 'clientlogin failed');
	} catch (err) {
		console.error('登录异常', err instanceof Error ? err.message : String(err));
		throw err;
	}
}

export default clientLogin;