import { env } from 'process';

const config = {
	valorant: {
		api: 'https://wiki.biligame.com/valorant/api.php',
		bot: {
			name: 'Hoshi4mi-bot@bot',
			password: env.BOT,
		},
	},
};

export default config;