import { env } from 'process';

const config = {
	useragent: `${env.MOEGIRL_API_USER_AGENT} (Github Actions; Hoshimi-bot) `, // for WAF
	password: env.MOEGIRL_PASSWORD, // for clientLogin
	zh: {
		api: 'https://mzh.moegirl.org.cn/api.php',
		bot: {
			name: '机娘星海酱@tf',
			password: env.ZH_BOT,
		},
		abot: {
			account: '星海-adminbot',
			name: '星海-adminbot@tf',
			password: env.ZH_ABOT,
		},
		ibot: {
			name: '星海-interfacebot@tf',
			password: env.ZH_IBOT,
		},
		sbot: {
			account: '星海-oversightbot',
		},
		main: {
			name: '星海子@gha',
			password: env.ZH_MAIN,
		},
	},
	cm: {
		api: 'https://commons.moegirl.org.cn/api.php',
		bot: {
			name: '机娘星海酱@tf',
			password: env.CM_BOT,
		},
		abot: {
			account: '星海-adminbot',
			name: '星海-adminbot@tf',
			password: env.CM_ABOT,
		},
		ibot: {
			name: '星海-interfacebot@tf',
			password: env.CM_IBOT,
		},
		sbot: {
			account: '星海-oversightbot',
		},
		main: {
			name: '星海子@gha',
			password: env.CM_MAIN,
		},
	},
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