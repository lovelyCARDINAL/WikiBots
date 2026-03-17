import { env } from 'process';

const config = {
	useragent: `${env.BWIKI_API_USER_AGENT} (Github Actions) `, // for WAF
	valorant: {
		api: 'https://wiki.biligame.com/valorant/api.php',
		bot: {
			name: 'Hoshi4mi-bot@bot',
			password: env.BWIKI_VALORANT_BOT,
		},
	},
};

export default config;