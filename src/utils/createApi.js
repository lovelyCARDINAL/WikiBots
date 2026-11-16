import { MediaWikiApi } from 'wiki-saikou';
import config from './config.js';

/**
 * Create a MediaWikiApi instance with the shared bot User-Agent.
 *
 * @param {keyof typeof config} [site='zh']
 * @returns {MediaWikiApi}
 */
function createApi(site = 'zh') {
	return new MediaWikiApi({
		baseURL: config[site].api,
		fexiosConfigs: {
			headers: { 'user-agent': config.useragent },
		},
	});
}

/**
 * Create a MediaWikiApi instance and log in with a configured bot account.
 *
 * @param {keyof typeof config} site
 * @param {'bot' | 'abot' | 'ibot' | 'main'} accountKey
 * @param {number} [retry=25]
 * @returns {Promise<MediaWikiApi>}
 */
async function createAndLogin(site, accountKey, retry = 25) {
	const api = createApi(site);
	const account = config[site][accountKey];
	const res = await api.login(
		account.name,
		account.password,
		undefined,
		{ retry, noCache: true },
	);
	console.log(res);
	return api;
}

export {
	createApi,
	createAndLogin,
};

export default createApi;
