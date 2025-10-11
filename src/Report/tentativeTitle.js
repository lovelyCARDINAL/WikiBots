import moment from 'moment';
import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import config from '../utils/config.js';
import readData from '../utils/readData.js';

Parser.config = 'moegirl';

const api = new MediaWikiApi(config.zh.api, {
	headers: { 'user-agent': config.useragent },
});

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	await api.login(
		config.zh.ibot.name,
		config.zh.ibot.password,
		undefined,
		{ retry: 25, noCache: true },
	).then(console.log);
	
	const overrideCategory = await (async () => {
		const data = JSON.parse(await readData('overrideCategory.json'));
		return [...data.page, ...data.temp, ...data.cat];
	})();

	const pages = await (async () => {
		const result = [];
		const eol = Symbol();
		let rvcontinue = undefined;
		while (rvcontinue !== eol) {
			const { data } = await api.post({
				prop: 'revisions|categories',
				generator: 'categorymembers',
				rvprop: 'content|timestamp',
				rvsection: '0',
				clshow: '!hidden',
				cllimit: 'max',
				gcmtitle: 'Category:需要更名的条目',
				gcmnamespace: '0',
				gcmtype: 'page',
				gcmlimit: 'max',
				rvcontinue,
			}, {
				retry: 15,
			});
			rvcontinue = data.continue ? data.continue.rvcontinue : eol;
			result.push(...Object.values(data.query.pages).filter((page) => page.revisions));
		}
		return result;
	})();

	let text = '* 本页面为[[U:星海-interfacebot|机器人]]生成的嵌入了{{tlx|暂定标题}}的条目。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}\n\n{| class="wikitable sortable" width=100%\n|-\n! 序号 || 条目名 || 原因 || style="width:35%"|部分所属分类 || style="min-width:80px"|最后版本\n';
	let count = 1;
	for (const page of pages) {
		const { title, revisions: [{ timestamp, content }], categories } = page;
		const category = categories ? categories
			.map(({ title }) => title)
			.filter((title) => !overrideCategory.includes(title))
			.map((title) => `[[:${title}]]`)
			.join('，')
			: 'data-sort-value="*" | <i style="color:red;">无分类！</i>';
		const wikitext = Parser.parse(content.replaceAll('\n', ''));
		/** @type {Parser.TranscludeToken | undefined} */
		const template = wikitext.querySelector('template:regex(name, /^Template:[暂暫]定[標标][题題]$/)');
		const reason = template?.getValue('1')?.trim() || (template ? 'data-sort-value="*" | <i style="color:red;">无</i>' : 'data-sort-value="*" | <i style="color:red;">找不到目标模板</i>');
		const time = `${moment(timestamp).utcOffset('+08:00').format('YYYY-MM-DD HH:mm')} (CST)`;
		text += `|-\n| ${count} || -{[[${title}]]}- || ${reason} || ${category} || ${time}\n`;
		count++;
	}
	text += '|}\n\n[[Category:萌娘百科数据报告]]';

	await api.postWithToken('csrf', {
		action: 'edit',
		pageid: '546073',
		text,
		summary: '更新数据报告',
		bot: true,
		notminor: true,
		tags: 'Bot',
		watchlist: 'nochange',
	}, {
		retry: 50,
		noCache: true,
	}).then(({ data }) => console.log(JSON.stringify(data)));

	console.log(`End time: ${new Date().toISOString()}`);
})();
