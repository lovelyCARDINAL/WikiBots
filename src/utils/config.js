import { env } from 'process';

const config = {
	apiuseragent: env.MOEGIRL_API_USER_AGENT, // For WAF
	zh: {
		api: 'https://mzh.moegirl.org.cn/api.php',
		bot: {
			name: '机娘星海酱@tf',
			password: env.ZH_BOT,
		},
		abot: {
			name: '星海-adminbot@tf',
			password: env.ZH_ABOT,
		},
		main: {
			name: '星海子@watch',
			password: env.ZH_MAIN,
		},
	},
	cm: {
		api: 'https://commons.moegirl.org.cn/api.php',
		bot: {
			name: '机娘星海酱@tf',
			password: env.CM_BOT,
		},
	},
	lb: {
		api: 'https://library.moegirl.org.cn/api.php',
	},
	en: {
		api: 'https://en.moegirl.org.cn/api.php',
	},
	ja: {
		api: 'https://ja.moegirl.org.cn/api.php',
	},
	meta: {
		api: 'https://meta.wikimedia.org/w/api.php',
	},
};

export default config;