import moment from 'moment';
import type { MediaWikiApi, MwApiParams } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import readData from '../common/readData.ts';
import { createAndLogin } from '../core/createApi.ts';
import paginate from '../core/paginate.ts';

interface ReportPage {
	pageid?: number;
	title: string;
	categories?: Array<{ title: string }>;
	revisions?: Array<{
		timestamp: string;
		content?: string;
		size: number;
	}>;
}

interface ParsedReportPage {
	pageid?: number;
	title: string;
	categories: Set<string>;
	timestamp?: string;
	size?: number;
	reason?: string;
}

/**
 * Load flattened override categories from raw JSON content of data/overrideCategory.json.
 */
function parseOverrideCategories(raw: string): string[] {
	const data = JSON.parse(raw) as { page: string[]; temp: string[]; cat: string[] };
	return [...data.page, ...data.temp, ...data.cat];
}

function parseTemplateReason(content: string, templateSelector: string, emptyReason: string): string {
	const wikitext = Parser.parse(content.replaceAll('\n', ''));
	const value = wikitext.querySelector<Parser.TranscludeToken>(templateSelector)?.getValue() as Record<string, string | undefined> | undefined
		|| { 0: 'data-sort-value="*" | <i style="color:red;">找不到目标模板</i>' };
	return Object.keys(value)
		.filter((key) => !Number.isNaN(Number(key)) && value[key]?.trim())
		.map((key) => value[key]?.trim())
		.join(' • ')
		|| emptyReason;
}

/**
 * Merge a single API page batch entry into the accumulator map, parsing and discarding `content` immediately.
 */
function mergePageIntoMap(
	pageMap: Map<string | number, ParsedReportPage>,
	page: ReportPage,
	overrideSet: Set<string>,
	parseReason: (content: string) => string,
): void {
	const key = page.pageid ?? page.title;
	let entry = pageMap.get(key);
	if (!entry) {
		entry = {
			pageid: page.pageid,
			title: page.title,
			categories: new Set<string>(),
		};
		pageMap.set(key, entry);
	}
	if (entry.timestamp === undefined && page.revisions?.[0]) {
		const { timestamp, content = '', size } = page.revisions[0];
		entry.timestamp = timestamp;
		entry.size = size;
		entry.reason = parseReason(content);
	}
	for (const { title: catTitle } of page.categories || []) {
		if (!overrideSet.has(catTitle)) {
			entry.categories.add(catTitle);
		}
	}
}

/**
 * Collect and merge paginated generator pages by pageid/title, parsing and dropping `content` per batch.
 */
async function collectPages(
	api: MediaWikiApi,
	params: MwApiParams,
	overrideSet: Set<string>,
	parseReason: (content: string) => string,
): Promise<ParsedReportPage[]> {
	const pageMap = new Map<string | number, ParsedReportPage>();
	for await (const data of paginate<{ query?: { pages?: Record<string, ReportPage> } }>(api, params)) {
		for (const page of Object.values(data?.query?.pages || {})) {
			mergePageIntoMap(pageMap, page, overrideSet, parseReason);
		}
	}
	return [...pageMap.values()].filter((page) => page.timestamp !== undefined);
}

interface BuildImproveReportOptions {
	pages: ParsedReportPage[];
	header: string;
}

/**
 * Build a sortable wikitable report for pages with improvement templates.
 */
function buildImproveReport({ pages, header }: BuildImproveReportOptions): string {
	let text = `${header}\n\n{| class="wikitable sortable" width=100%\n|-\n! 序号 || 条目名 || 改进方向 || style="width:30%"|部分所属分类 || style="min-width:50px"|代码长度 || style="min-width:80px"|最后版本\n`;
	let count = 1;
	for (const page of pages) {
		if (page.timestamp === undefined || page.size === undefined || page.reason === undefined) {
			continue;
		}
		const category = page.categories.size
			? [...page.categories].map((catTitle) => `[[:${catTitle}]]`).join('，')
			: 'data-sort-value="*" | <i style="color:red;">无分类！</i>';
		const time = `${moment(page.timestamp).utcOffset('+08:00').format('YYYY-MM-DD HH:mm')} (CST)`;
		text += `|-\n| ${count} || [[${page.title}]] || ${page.reason} || ${category} || ${page.size} || ${time}\n`;
		count++;
	}
	return `${text}|}\n\n[[Category:萌娘百科数据报告]][[Category:积压工作]]`;
}

/**
 * Publish a generated report page via CSRF edit.
 */
async function publishReport(api: MediaWikiApi, pageid: string, text: string): Promise<void> {
	const { data } = await api.postWithToken<{ edit?: { result?: string } }>('csrf', {
		action: 'edit',
		pageid,
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
	console.log(JSON.stringify(data));
	if (data?.edit?.result && data.edit.result !== 'Success') {
		throw new Error(`publishReport failed: ${JSON.stringify(data)}`);
	}
}

interface RunImproveReportOptions {
	queryParams: MwApiParams;
	header: string;
	templateSelector: string;
	emptyReason: string;
	targetPageId: string;
}

/**
 * End-to-end runner for improvement report bots: login, collect pages, build report, and publish.
 */
async function runImproveReport({
	queryParams,
	header,
	templateSelector,
	emptyReason,
	targetPageId,
}: RunImproveReportOptions): Promise<void> {
	console.log(`Start time: ${new Date().toISOString()}`);
	const api = await createAndLogin('zh', 'ibot');
	const overrideSet = new Set(parseOverrideCategories(await readData('overrideCategory.json')));
	const pages = await collectPages(
		api,
		{
			prop: 'revisions|categories',
			rvprop: 'content|timestamp|size',
			rvsection: '0',
			clshow: '!hidden',
			cllimit: 'max',
			...queryParams,
		},
		overrideSet,
		(content) => parseTemplateReason(content, templateSelector, emptyReason),
	);
	const text = buildImproveReport({ pages, header });
	await publishReport(api, targetPageId, text);
	console.log(`End time: ${new Date().toISOString()}`);
}

export {
	parseOverrideCategories,
	collectPages,
	buildImproveReport,
	publishReport,
	runImproveReport,
};
