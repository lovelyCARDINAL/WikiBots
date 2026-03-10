import { env } from 'process';

const config = {
	valorant: {
		api: 'https://wiki.biligame.com/valorant/api.php',
		account: 'Hoshi4mi-bot',
		password: env.MOEGIRL_PASSWORD, // for clientLogin
		bot: {
			name: 'Hoshi4mi-bot@bot',
			password: env.BWIKI_VALORANT_BOT,
		},
	},
};

export default config;