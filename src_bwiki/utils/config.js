import { env } from 'process';

const config = {
	valorant: {
		api: 'https://wiki.biligame.com/valorant/api.php',
		bot: {
			name: 'Hoshi4mi-bot@bot',
			password: env.BWIKI_VALORANT_BOT,
		},
	},
};

export default config;