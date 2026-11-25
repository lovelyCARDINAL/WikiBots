import Parser from 'wikiparser-node';
import { createAndLogin } from '../utils/createApi.ts';
import readData from '../utils/readData.ts';
import { parseOverrideCategories, collectPages, buildImproveReport, publishReport } from '../utils/report.ts';

Parser.config = 'moegirl';

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	const api = await createAndLogin('zh', 'ibot');

	const overrideCategory = parseOverrideCategories(await readData('overrideCategory.json'));

	const pages = await collectPages(api, {
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
	});

	const text = buildImproveReport({
		pages,
		overrideCategory,
		header: '* 本页面为[[U:星海-interfacebot|机器人]]生成的嵌入了{{tlx|急需改进}}的条目。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}',
		templateSelector: 'template:regex(name, /^Template:急需改[进進]$/)',
		emptyReason: 'data-sort-value="*" | <span style="color:red;">未填写</span>',
	});

	await publishReport(api, '480052', text);

	console.log(`End time: ${new Date().toISOString()}`);
})();
