import moment from 'moment';
import Parser from 'wikiparser-node';
import readData from '../utils/common/readData.ts';
import splitAndJoin from '../utils/common/splitAndJoin.ts';
import { createAndLogin } from '../utils/core/createApi.ts';
import { safePostWithToken } from '../utils/core/retry.ts';

Parser.config = 'moegirl';

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	const api = await createAndLogin('zh', 'ibot');
	
	const overrideCategory = await (async () => {
		const data = JSON.parse(await readData('overrideCategory.json'));
		return [...data.page, ...data.temp, ...data.cat, ...data.vtuber];
	})();

	const cats = await api.post<{
		query: { categorymembers: Array<{ title: string }> };
	}>({
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
		return await api.post<{
			query: { categorymembers: Array<{ pageid: number }> };
		}>({
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
	})).then((result) => splitAndJoin([...new Set(result.flat())], 500));

	const pages = await Promise.all(idslist.map(async (pageids) => {
		return await api.post<{
			query: {
				pages: Array<{
					title: string;
					revisions: Array<{ timestamp: string; content: string; size: number }>;
					categories?: Array<{ title: string }>;
				}>;
			};
		}>({
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
			?.map(({ title: catTitle }) => catTitle)
			.filter((catTitle) => !overrideCategory.includes(catTitle))
			.map((catTitle) => `[[:${catTitle}]]`)
			.join('，')
			|| '';
		const wikitext = Parser.parse(content.replaceAll('\n', ''));
		const name = wikitext.querySelectorAll('template')
			.map(({ name: tplName }) => /(?:急需改[进進]|TOP)$/i.test(tplName.trim()) && tplName).filter(Boolean)?.[0];
		if (!name) {
			console.log(`No top template: ${title}`);
			continue;
		}
		const value = wikitext.querySelector<Parser.TranscludeToken>(`template#${name}`)?.getValue() as Record<string, string | undefined> | undefined;
		const reason = value
			? Object.keys(value)
				.filter((key) => !Number.isNaN(Number(key)) && value[key]?.trim())
				.map((key) => value[key]?.trim())
				.join(' • ')
			: '';
		if (!reason) {
			continue;
		}
		const time = `${moment(timestamp).utcOffset('+08:00').format('YYYY-MM-DD HH:mm')} (CST)`;
		text += `|-\n| ${count} || [[${title}]] || ${reason} || ${category} || ${size} || ${time}\n`;
		count++;
	}
	text += '|}\n\n[[Category:萌娘百科数据报告]]';

	await safePostWithToken(api, 'csrf', {
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
	});

	console.log(`End time: ${new Date().toISOString()}`);
})();
