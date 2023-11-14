import moment from 'moment';
import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import config from './utils/config.js';
import readData from './utils/readData.js';
import splitAndJoin from './utils/splitAndJoin.js';

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
		return [...data.page, ...data.temp, ...data.cat, ...data.vtuber];
	})();

	const cats = await api.post({
		list: 'categorymembers',
		cmtitle: 'Category:各语言虚拟UP主',
		cmtype: 'subcat',
		cmlimit: 'max',
	}, {
		retry: 15,
	}).then(({ data: { query: { categorymembers } } }) => {
		return [...categorymembers.map(({ title }) => title), 'Category:虚拟UP主']; // TODO: remove 'Category:虚拟UP主' future
	});

	const idslist = await Promise.all(cats.map(async (cat) => {
		return await api.post({
			list: 'categorymembers',
			cmtitle: cat,
			cmprop: 'ids',
			cmnamespace: '0',
			cmtype: 'page',
			cmlimit: 'max',
		}, {
			retry: 15,
		}).then(({ data: { query: { categorymembers } } }) => {
			return categorymembers.map(({ pageid }) => pageid);
		});
	})).then((result) => splitAndJoin([...new Set(result.flat(Infinity))], 500));

	const pages = await Promise.all(idslist.map(async (pageids) => {
		return await api.post({
			prop: 'revisions|categories',
			pageids,
			rvprop: 'content|timestamp|size',
			rvsection: '0',
			clshow: '!hidden',
			cllimit: 'max',
		}, {
			retry: 15,
		}).then(({ data: { query: { pages } } }) => {
			return pages;
		});
	})).then((result) => result.flat());

	let text = '* 本页面为[[U:星海-interfacebot|机器人]]生成的填写了改进方向的[[虚拟UP主]]条目。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}\n\n{| class="wikitable sortable" width=100%\n|-\n! 序号 || 条目名 || 改进方向 || style="width:30%"|部分所属分类 || style="min-width:50px"|代码长度 || style="min-width:80px"|最后版本\n';
	let count = 1;
	for (const page of pages) {
		const { title, revisions: [{ timestamp, content, size }], categories } = page;
		const category = categories
			?.map(({ title }) => title)
			.filter((title) => !overrideCategory.includes(title))
			.map((title) => `[[:${title}]]`)
			.join('，')
			|| '';
		const wikitext = Parser.parse(content.replaceAll('\n', ''));
		const name = wikitext.querySelectorAll('template')
			.map(({ name }) => /(?:急需改[进進]|TOP)$/i.test(name.trim()) && name).filter(Boolean)?.[0];
		if (!name) {
			console.log(`No top template: ${title}`);
			continue;
		}
		const value = wikitext.querySelector(`template#${name}`)?.getValue();
		const reason = Object.keys(value)
			.filter((key) => !isNaN(key) && value[key]?.trim())
			.map((key) => value[key]?.trim())
			.join(' • ');
		if (!reason) {
			continue;
		}
		const time = `${moment(timestamp).utcOffset('+08:00').format('YYYY-MM-DD HH:mm')} (CST)`;
		text += `|-\n| ${count} || [[${title}]] || ${reason} || ${category} || ${size} || ${time}\n`;
		count++;
	}
	text += '|}\n\n[[Category:萌娘百科数据报告]]';

	await api.postWithToken('csrf', {
		action: 'edit',
		pageid: '558472',
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
