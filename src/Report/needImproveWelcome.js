import moment from 'moment';
import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import config from '../utils/config.js';
import parserConfig from '../utils/parserConfig.js';
import readData from '../utils/readData.js';

Parser.config = 'moegirl';
Parser.redirects = new Map(parserConfig.redirects);

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
		let geicontinue = undefined;
		while (geicontinue !== eol) {
			const { data } = await api.post({
				prop: 'revisions|categories',
				generator: 'embeddedin',
				rvprop: 'content|timestamp|size',
				rvsection: '0',
				clshow: '!hidden',
				cllimit: 'max',
				geititle: 'Template:欢迎编辑/有填写改进方向',
				geinamespace: '0',
				geifilterredir: 'nonredirects',
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

	let text = '* 本页面为[[U:星海-interfacebot|机器人]]生成的嵌入了{{tlx|欢迎编辑}}并填写了改进方向的条目。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}\n\n{| class="wikitable sortable" width=100%\n|-\n! 序号 || 条目名 || 改进方向 || style="width:30%"|部分所属分类 || style="min-width:50px"|代码长度 || style="min-width:80px"|最后版本\n';
	let count = 1;
	for (const page of pages) {
		const { title, revisions: [{ timestamp, content, size }], categories } = page;
		const category = categories
			?.map(({ title }) => title)
			.filter((title) => !overrideCategory.includes(title))
			.map((title) => `[[:${title}]]`)
			.join('，')
			|| 'data-sort-value="*" | <i style="color:red;">无分类！</i>';
		const wikitext = Parser.parse(content.replaceAll('\n', ''));
		const value = wikitext.querySelector('template:regex(name, /^Template:[欢歡]迎[編编][辑輯]$/)')?.getValue() || ['data-sort-value="*" | <i style="color:red;">找不到目标模板</i>'];
		const reason = Object.keys(value)
			.filter((key) => !isNaN(key) && value[key]?.trim())
			.map((key) => value[key]?.trim())
			.join(' • ')
			|| 'data-sort-value="*" | <i style="color:red;">找不到模板参数</i>';
		const time = `${moment(timestamp).utcOffset('+08:00').format('YYYY-MM-DD HH:mm')} (CST)`;
		text += `|-\n| ${count} || [[${title}]] || ${reason} || ${category} || ${size} || ${time}\n`;
		count++;
	}
	text += '|}\n\n[[Category:萌娘百科数据报告]][[Category:积压工作]]';

	await api.postWithToken('csrf', {
		action: 'edit',
		pageid: '426106',
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
