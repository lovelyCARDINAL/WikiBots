import {env} from 'process';

const config = {
	apiuseragent: env.MOEGIRL_API_USER_AGENT, // For WAF
	api: {
		zh: 'https://mzh.moegirl.org.cn/api.php',
		cm: 'https://commons.moegirl.org.cn/api.php',
		lb: 'https://library.moegirl.org.cn/api.php',
		en: 'https://en.moegirl.org.cn/api.php',
		ja: 'https://ja.moegirl.org.cn/api.php',
		meta: 'https://meta.wikimedia.org/w/api.php',
	},
	bot: {
		zh: {
			name: '机娘星海酱@tf',
			password: env.ZH_BOT,
		},
	},
	abot: {
		zh: {
			name: '星海-adminbot@tf',
			password: env.ZH_ABOT,
		},
	},
	main: {
		zh: {
			name: '星海子@watch',
			password: env.ZH_MAIN,
		},
	},
};

export default config;