import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import config from '../utils/config.js';

Parser.config = 'moegirl';

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

	const root = Parser.parse(content, false, 10); // 不解析语言变体转换
	const selector = 'list + link[name^=User:], list + html#span + link[name^=User:]';
	const users = root.querySelectorAll(selector);
	const linesWithTemplate = new Set(root.querySelectorAll('template#Template:No_abuselog').map((token) => token.getBoundingClientRect().top));
	const time = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
	const promises = [];

	for (const user of users) {
		const rect = user.getBoundingClientRect();
		const name = user.name.slice(5);
		const endLine = rect.top + rect.height - 1;
		if (linesWithTemplate.has(endLine)) {
			continue;
		}
		promises.push((async () => {
			const { data: { query: { abuselog, usercontribs } } } = await api.post({
				list: 'abuselog|usercontribs',
				afluser: name,
				afllimit: '1',
				uclimit: '1',
				ucend: time,
				ucuser: name,
			}, {
				retry: 25,
			});
			if (!abuselog.length && !usercontribs.length) {
				user.after(' {{No abuselog}}');
			}
		})());
	}

	await Promise.all(promises);

	await api.postWithToken('csrf', {
		action: 'edit',
		title: '萌娘百科:长期破坏者',
		text: String(root),
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
