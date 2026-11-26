import moment from 'moment';
import Parser from 'wikiparser-node';
import readData from '../utils/common/readData.ts';
import { createAndLogin } from '../utils/core/createApi.ts';
import paginate from '../utils/core/paginate.ts';
import { safePostWithToken } from '../utils/core/retry.ts';

Parser.config = 'moegirl';

interface TentativeApiPage {
	pageid?: number;
	title: string;
	revisions?: Array<{ timestamp: string; content?: string }>;
	categories?: Array<{ title: string }>;
}

interface ParsedTentativePage {
	title: string;
	timestamp?: string;
	reason?: string;
	categories: Set<string>;
}

function parseTentativeReason(content: string): string {
	const wikitext = Parser.parse(content.replaceAll('\n', ''));
	const template = wikitext.querySelector<Parser.TranscludeToken>('template:regex(name, /^Template:[暂暫]定[標标][题題]$/)');
	return template?.getValue('1')?.trim()
		|| (template ? 'data-sort-value="*" | <i style="color:red;">无</i>' : 'data-sort-value="*" | <i style="color:red;">找不到目标模板</i>');
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	const api = await createAndLogin('zh', 'ibot');

	const overrideSet = await (async () => {
		const data = JSON.parse(await readData('overrideCategory.json'));
		return new Set<string>([...data.page, ...data.temp, ...data.cat]);
	})();

	const pageMap = new Map<string | number, ParsedTentativePage>();
	for await (const data of paginate<{ query?: { pages?: Record<string, TentativeApiPage> } }>(api, {
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
	})) {
		for (const page of Object.values(data.query?.pages || {})) {
			const key = page.pageid ?? page.title;
			let entry = pageMap.get(key);
			if (!entry) {
				entry = { title: page.title, categories: new Set<string>() };
				pageMap.set(key, entry);
			}
			if (entry.timestamp === undefined && page.revisions?.[0]) {
				const { timestamp, content = '' } = page.revisions[0];
				entry.timestamp = timestamp;
				entry.reason = parseTentativeReason(content);
			}
			for (const { title: catTitle } of page.categories || []) {
				if (!overrideSet.has(catTitle)) {
					entry.categories.add(catTitle);
				}
			}
		}
	}

	let text = '* 本页面为[[U:星海-interfacebot|机器人]]生成的嵌入了{{tlx|暂定标题}}的条目。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}\n\n{| class="wikitable sortable" width=100%\n|-\n! 序号 || 条目名 || 原因 || style="width:35%"|部分所属分类 || style="min-width:80px"|最后版本\n';
	let count = 1;
	for (const page of pageMap.values()) {
		if (page.timestamp === undefined || page.reason === undefined) {
			continue;
		}
		const category = page.categories.size
			? [...page.categories].map((catTitle) => `[[:${catTitle}]]`).join('，')
			: 'data-sort-value="*" | <i style="color:red;">无分类！</i>';
		const time = `${moment(page.timestamp).utcOffset('+08:00').format('YYYY-MM-DD HH:mm')} (CST)`;
		text += `|-\n| ${count} || -{[[${page.title}]]}- || ${page.reason} || ${category} || ${time}\n`;
		count++;
	}
	text += '|}\n\n[[Category:萌娘百科数据报告]]';

	await safePostWithToken(api, 'csrf', {
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
	});

	console.log(`End time: ${new Date().toISOString()}`);
})();
