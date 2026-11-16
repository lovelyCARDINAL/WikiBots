import tls from 'node:tls';
import { MediaWikiApi } from 'wiki-saikou';
import config from '../utils/config.js';

const useTlsCompat = process.env.TLS_COMPAT === '1';

if (useTlsCompat) {
	// 去掉 OpenSSL 3.5 默认的 X25519MLKEM768，模拟 OpenSSL 3.0 曲线列表
	tls.DEFAULT_ECDH_CURVE = 'X25519:P-256:P-384:P-521';
}

const envLabel = `Node ${process.version} | OpenSSL ${process.versions.openssl} | compat=${useTlsCompat}`;
console.log(`Start time: ${new Date().toISOString()}`);
console.log(`Env: ${envLabel}`);
console.log(`ECDH Curve: ${tls.DEFAULT_ECDH_CURVE}`);
console.log(`Default Ciphers: ${tls.DEFAULT_CIPHERS}\n`);

const api = new MediaWikiApi({
	baseURL: config.zh.api,
	fexiosConfigs: {
		headers: { 'user-agent': config.useragent },
	},
});

(async () => {
	try {
		const loginRes = await api.login(
			config.zh.bot.name,
			config.zh.bot.password,
			undefined,
			{ retry: 5, noCache: true },
		);
		console.log('Login result:', loginRes);

		const { data } = await api.postWithToken(
			'csrf',
			{
				action: 'edit',
				title: 'User:星海子/test/001',
				text: `${new Date().toISOString()} (${envLabel})`,
				summary: `Github Actions Test (${process.version}, compat=${useTlsCompat})`,
				bot: true,
				minor: true,
				tags: 'Bot',
			},
			{
				retry: 5,
				noCache: true,
			},
		);
		console.log('Edit result:', JSON.stringify(data));
	} catch (err) {
		console.error('Request failed:', err);
		if (err?.cause) {
			console.error('Error cause:', err.cause);
		}
		process.exit(1);
	}
})();