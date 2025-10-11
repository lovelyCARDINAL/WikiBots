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
				geititle: 'Template:信息栏2.0',
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

	for (const page of pages) {
		const { title, revisions: [{ content }] } = page;
		console.log(`处理 ${title} 中！`);

		const parser = Parser.parse(content);
		/** @type {Parser.TranscludeToken[]} */
		const templates = parser.querySelectorAll('template#Template:信息栏2.0');
		if (templates.length === 0) {
			continue;
		}
		let summary = '替换{{[[T:信息栏2.0|信息栏2.0]]}}为';
		for (const temp of templates) {
			let legacy = false;
			for (const arg of temp.getAllArgs()) {
				arg.escape();
				if (!legacy) {
					legacy = /^(class|.+-style|border|float|cellpadding|cellspacing)$/.test(arg.name);
				}
				if (!/^(class|m-style|border|float|m-width|m-b?color|notitle|标题|title|top-style|top-b?color|图片|image|图片大小|size|alt|图片信息|图片说明|image-style|tabs|t-style|t-b?color|l-style|l-width|l-b?color|r-style|i-style|bottom|b-style|cellpadding|cellspacing|\d+)$/.test(arg.name)) {
					temp.newAnonArg(`${arg.name} :: ${arg.value}\n`);
					temp.removeArg(arg.name);
				}
			}
			legacy ? temp.replaceTemplate('Infobox3/legacy\n') : temp.replaceTemplate('Infobox3\n');
			summary += `{{[[T:${legacy ? 'Infobox3/legacy|Infobox3/legacy' : 'Infobox3|Infobox3'}]]}}`;
		}

		await api.postWithToken('csrf', {
			action: 'edit',
			title,
			text: parser.toString(),
			summary,
			bot: true,
			notminor: true,
			tags: 'Bot',
			watchlist: 'nochange',
		}, {
			retry: 50,
			noCache: true,
		}).then(({ data }) => console.log(JSON.stringify(data)));
	}

	console.log(`End time: ${new Date().toISOString()}`);
})();
