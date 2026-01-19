import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
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

	const pages = await (async () => {
		const result = [];
		const eol = Symbol();
		let geicontinue = undefined;
		while (geicontinue !== eol) {
			const { data } = await api.post({
				prop: 'revisions',
				generator: 'embeddedin',
				rvprop: 'content',
				geititle: 'Template:VOCALOID Songbox Introduction',
				geinamespace: '0',
				geilimit: '500',
				geicontinue,
			}, {
				retry: 15,
			});
			geicontinue = data.continue ? data.continue.geicontinue : eol;
			result.push(...Object.values(data.query.pages).filter((page) => page.revisions));
		}
		return result;
	})();

	await Promise.all(pages.map(async ({ title, revisions: [{ content }] }) => {
		if (title !== 'Undefined') {
			return; // Test only
		}
		const parser = Parser.parse(content);
		const templates = parser.querySelectorAll('template#Template:VOCALOID_Songbox_Introduction');
		if (templates.length === 0) {
			return;
		}
		for (const temp of templates) {
			let i = 1;
			for (const arg of temp.getAllArgs()) {
				arg.escape();
				if (!/^(lbgcolor|ltcolor|rbdcolor|args|LDC|ldc|author|anchor|授权信息|list\d+|group\d+|d+)$/.test(arg.name)) {
					if (i === 1) {
						console.log(`处理 ${title} 中！`); // 不知道为什么遇到[[Undefined]]后续会报错
					}
					let group = `group${i}`;
					while (temp.hasArg(group)) {
						group = `group${++i}`;
					}
					temp.setValue(group, `${arg.name}\n`);
					temp.setValue(`list${i++}`, `${arg.value}\n`);
					temp.removeArg(arg.name);
				}
			}
		}
		const text = parser.toString();
		if (text !== content) {
			await api.postWithToken('csrf', {
				action: 'edit',
				title,
				text,
				summary: '修复{{[[T:VOCALOID Songbox Introduction|VOCALOID Songbox Introduction]]}}参数乱序问题',
				bot: true,
				notminor: true,
				tags: 'Bot',
				watchlist: 'nochange',
			}, {
				retry: 50,
				noCache: true,
			}).then(({ data }) => console.log(JSON.stringify(data)));
		}
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();