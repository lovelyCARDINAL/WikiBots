import type { MediaWikiApi } from 'wiki-saikou';
import logger, { c } from '../common/logger.ts';
import config from './config.ts';

async function clientLogin(
	api: MediaWikiApi,
	username: string,
	password: string | undefined = config.password,
) {
	if (!password) {
		throw new Error('Missing password for clientLogin');
	}
	try {
		const { data } = await api.postWithToken<{
			clientlogin?: { status?: string; username?: string; message?: string };
		}>(
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
			logger.success(`登录成功 ${c.cyan(data.clientlogin.username || username)}`);
			return data;
		}
		throw new Error(data.clientlogin?.message || 'clientlogin failed');
	} catch (err) {
		logger.error('登录异常', err instanceof Error ? err.message : String(err));
		throw err;
	}
}

export default clientLogin;
