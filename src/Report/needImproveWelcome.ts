import Parser from 'wikiparser-node';
import parserConfig from '../utils/core/parserConfig.ts';
import { runImproveReport } from '../utils/report/index.ts';

Parser.config = 'moegirl';
Parser.redirects = new Map(parserConfig.redirects);

await runImproveReport({
	queryParams: {
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
	},
	header: '* 本页面为[[U:星海-interfacebot|机器人]]生成的嵌入了{{tlx|欢迎编辑}}并填写了改进方向的条目。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}',
	templateSelector: 'template:regex(name, /^Template:[欢歡]迎[編编][辑輯]$/)',
	emptyReason: 'data-sort-value="*" | <i style="color:red;">找不到模板参数</i>',
	targetPageId: '426106',
});
