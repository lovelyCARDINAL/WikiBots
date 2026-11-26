import { env } from 'process';

function createSiteBotConfig(api: string, prefix: 'ZH' | 'CM') {
	return {
		api,
		bot: {
			name: '机娘星海酱@tf',
			password: env[`${prefix}_BOT`] ?? '',
		},
		abot: {
			account: '星海-adminbot',
			name: '星海-adminbot@tf',
			password: env[`${prefix}_ABOT`] ?? '',
		},
		ibot: {
			name: '星海-interfacebot@tf',
			password: env[`${prefix}_IBOT`] ?? '',
		},
		sbot: {
			account: '星海-oversightbot',
		},
		main: {
			name: '星海子@gha',
			password: env[`${prefix}_MAIN`] ?? '',
		},
	};
}

const useragent = `${env.MOEGIRL_API_USER_AGENT || 'Hoshimi-bot'} (GithubActions; Hoshimi-bot) `;
const indexUseragent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 ${useragent}`.trim();

const config = {
	useragent, // for WAF
	indexUseragent,
	password: env.MOEGIRL_PASSWORD ?? '', // for clientLogin
	zh: createSiteBotConfig('https://mzh.moegirl.org.cn/api.php', 'ZH'),
	cm: createSiteBotConfig('https://commons.moegirl.org.cn/api.php', 'CM'),
	lb: {
		api: 'https://library.moegirl.org.cn/api.php',
		abot: {
			account: '星海-adminbot',
		},
	},
	en: {
		api: 'https://en.moegirl.org.cn/api.php',
		abot: {
			account: '星海-adminbot',
		},
	},
	ja: {
		api: 'https://ja.moegirl.org.cn/api.php',
		abot: {
			account: '星海-adminbot',
		},
	},
	meta: {
		api: 'https://meta.wikimedia.org/w/api.php',
	},
};

export default config;
