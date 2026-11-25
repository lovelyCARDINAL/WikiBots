import Parser from 'wikiparser-node';
import { runImproveReport } from '../utils/report/index.ts';

Parser.config = 'moegirl';

await runImproveReport({
	queryParams: {
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
	},
	header: '* 本页面为[[U:星海-interfacebot|机器人]]生成的嵌入了{{tlx|急需改进}}的条目。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}',
	templateSelector: 'template:regex(name, /^Template:急需改[进進]$/)',
	emptyReason: 'data-sort-value="*" | <span style="color:red;">未填写</span>',
	targetPageId: '480052',
});
