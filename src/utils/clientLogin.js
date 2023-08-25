import process from 'process';
import config from './config.js';

/**
 * @param {import('../src').MediaWikiApi} api
 * @param {string} username
 * @param {string} [password=config.password]
 */
// eslint-disable-next-line require-await
async function clientLogin(api, username, password = config.password) {
	return api
		.postWithToken(
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
		)
		.then(({ data }) => {
			if (data.clientlogin.status === 'PASS') {
				console.log('登录成功', data);
				return data;
			}
			throw new Error(data.clientlogin.message);
		})
		.catch((err) => {
			console.error('登录异常', err);
			process.exit(1);
		});
}

export default clientLogin;