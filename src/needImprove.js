import moment from 'moment';
import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import config from './utils/config.js';
import readData from './utils/readData.js';

const api = new MediaWikiApi(config.zh.api, { headers: { 'api-user-agent': config.apiuseragent || '' } });

console.log(`Start time: ${new Date().toISOString()}`);

(async () => {
	await api.login(config.zh.ibot.name, config.zh.ibot.password).then(console.log, console.error);
	
	const overrideCategory = await (async () => {
		const data = JSON.parse(await readData('overrideCategory.json'));
		return [ ...data.page, ...data.temp, ...data.cat ];
	})();

	const pages = await (async () => {
		const result = [];
		const eol = Symbol();
		let rvcontinue = undefined;
		while (rvcontinue !== eol) {
			const { data } = await api.post({
				prop: 'revisions|categories',
				generator: 'categorymembers',
				rvprop: 'content|timestamp|size',
				rvsection: '0',
				clshow: '!hidden',
				cllimit: 'max',
				gcmtitle: 'Category:急需改进',
				gcmnamespace: '0',
				gcmtype: 'page',
				gcmlimit: 'max',
				...rvcontinue && { rvcontinue },
			});
			rvcontinue = data.continue ? data.continue.rvcontinue : eol;
			result.push(...Object.values(data.query.pages).filter((page) => page.revisions));
		}
		return result;
	})();

	let text = '* 本页面为[[U:星海-interfacebot|机器人]]生成的嵌入了{{tlx|急需改进}}的条目。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}\n\n{| class="wikitable sortable" width=100%\n|-\n! 序号 || 条目名 || 改进方向 || style="width:30%"|部分所属分类 || style="min-width:50px"|代码长度 || style="min-width:80px"|最后版本\n';
	let count = 1;
	for (const page of pages) {
		const { title, revisions: [ { timestamp, content, size } ], categories } = page;
		const category = categories ? categories
			.map(({ title }) => title)
			.filter((title) => !overrideCategory.includes(title))
			.map((title) => `[[:${title}]]`)
			.join('，')
			: 'data-sort-value="*" | <i style="color:red;">无分类！</i>';
		const wikitext = Parser.parse(content.replace(/\n/g, '').replace(/急需改[进進]/, '急需改进'));
		const value = wikitext.querySelector('template#Template:急需改进')?.getValue() || [ 'data-sort-value="*" | <i style="color:red;">找不到目标模板</i>' ];
		const reason = Object.keys(value)
			.filter((key) => !isNaN(key) && value[key]?.trim())
			.map((key) => value[key]?.trim())
			.join(' • ')
			|| 'data-sort-value="*" | <span style="color:red;">未填写</span>';
		const time = `${moment(timestamp).utcOffset('+08:00').format('YYYY-MM-DD HH:mm')} (CST)`;
		text += `|-\n| ${count} || [[${title}]] || ${reason} || ${category} || ${size} || ${time}\n`;
		count++;
	}
	text += '|}\n\n[[Category:萌娘百科数据报告]]';

	const { data } = await api.postWithToken('csrf', {
		action: 'edit',
		pageid: '480052',
		text,
		summary: '更新数据报告',
		bot: true,
		notminor: true,
		tags: 'Bot',
		watchlist: 'nochange',
	});
	console.log(JSON.stringify(data));

	console.log(`End time: ${new Date().toISOString()}`);
})();
