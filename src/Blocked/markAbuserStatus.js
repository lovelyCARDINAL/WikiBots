import { MediaWikiApi } from 'wiki-saikou';
import config from '../utils/config.js';

const api = new MediaWikiApi(config.zh.api, {
	headers: { 'user-agent': config.useragent },
});

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	await api.login(
		config.zh.abot.name,
		config.zh.abot.password,
		undefined,
		{ retry: 25, noCache: true },
	).then(console.log);

	const { data: { query: { pages: [{ revisions: [{ content }] }] } } } = await api.post({
		prop: 'revisions',
		titles: '萌娘百科:长期破坏者',
		rvprop: 'content',
	}, {
		retry: 25,
	});

	const lines = content.split('\n');
	const lineRegex = /^\* *(?:<span.*?>|-\{)?\[\[User:.*?(?<!{{No[ _]abuselog}}\s*)$/i,
		userRegex = /\[\[User:(.*?)\]\]/;
	const time = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

	await Promise.all(lines.map(async (line, i) => {
		if (lineRegex.test(line)) {
			const user = line.match(userRegex)[1];
			const { data: { query: { abuselog, usercontribs } } } = await api.post({
				list: 'abuselog|usercontribs',
				afluser: user,
				afllimit: '1',
				uclimit: '1',
				ucend: time,
				ucuser: user,
			}, {
				retry: 25,
			});
			if (!abuselog.length && !usercontribs.length) {
				lines[i] += ' {{No abuselog}}';
			}
		}
	}));

	await api.postWithToken('csrf', {
		action: 'edit',
		title: '萌娘百科:长期破坏者',
		text: lines.join('\n'),
		bot: true,
		nocreate: true,
		tags: 'Bot',
		summary: '更新长期破坏者账号状态',
		watchlist: 'nochange',
	}, {
		retry: 50,
		noCache: true,
	}).then(({ data }) => console.log(JSON.stringify(data)));

	console.log(`End time: ${new Date().toISOString()}`);
})();