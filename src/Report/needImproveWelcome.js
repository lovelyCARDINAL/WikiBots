import Parser from 'wikiparser-node';
import { createAndLogin } from '../utils/createApi.js';
import paginate from '../utils/paginate.js';
import parserConfig from '../utils/parserConfig.js';
import readData from '../utils/readData.js';
import { parseOverrideCategories, buildImproveReport, publishReport } from '../utils/report.js';

Parser.config = 'moegirl';
Parser.redirects = new Map(parserConfig.redirects);

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	const api = await createAndLogin('zh', 'ibot');

	const overrideCategory = parseOverrideCategories(await readData('overrideCategory.json'));

	const pages = await (async () => {
		const result = [];
		for await (const data of paginate(api, {
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
		})) {
			if (data.query?.pages) {
				result.push(...Object.values(data.query.pages).filter((page) => page.revisions));
			}
		}
		return result;
	})();

	const text = buildImproveReport({
		pages,
		overrideCategory,
		header: '* 本页面为[[U:星海-interfacebot|机器人]]生成的嵌入了{{tlx|欢迎编辑}}并填写了改进方向的条目。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}',
		templateSelector: 'template:regex(name, /^Template:[欢歡]迎[編编][辑輯]$/)',
		emptyReason: 'data-sort-value="*" | <i style="color:red;">找不到模板参数</i>',
	});

	await publishReport(api, '426106', text);

	console.log(`End time: ${new Date().toISOString()}`);
})();
