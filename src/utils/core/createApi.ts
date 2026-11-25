import { MediaWikiApi } from 'wiki-saikou';
import config from './config.ts';

type SiteKey = 'zh' | 'cm' | 'lb' | 'en' | 'ja' | 'meta';
type AccountKey = 'bot' | 'abot' | 'ibot' | 'main';

/**
 * Create a MediaWikiApi instance with the shared bot User-Agent.
 */
function createApi(site: SiteKey = 'zh'): MediaWikiApi {
	return new MediaWikiApi({
		baseURL: config[site].api,
		fexiosConfigs: {
			headers: { 'user-agent': config.useragent },
		},
	});
}

interface AccountCredentials {
	account?: string;
	name?: string;
	password?: string;
}

interface SiteConfig {
	api: string;
	bot?: AccountCredentials;
	abot?: AccountCredentials;
	ibot?: AccountCredentials;
	sbot?: AccountCredentials;
	main?: AccountCredentials;
}

/**
 * Create a MediaWikiApi instance and log in with a configured bot account.
 */
async function createAndLogin(
	site: SiteKey,
	accountKey: AccountKey,
	retry = 25,
): Promise<MediaWikiApi> {
	const siteConfig: SiteConfig = config[site];
	const account = siteConfig[accountKey];
	if (!account?.name || !account?.password) {
		throw new Error(`Missing credentials for ${site}.${accountKey}`);
	}
	const api = createApi(site);
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

export type { SiteKey, AccountKey };
export default createApi;
