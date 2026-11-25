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

/**
 * Load flattened override categories from raw JSON content of data/overrideCategory.json.
 */
function parseOverrideCategories(raw: string): string[] {
	const data = JSON.parse(raw) as { page: string[]; temp: string[]; cat: string[] };
	return [...data.page, ...data.temp, ...data.cat];
}

/**
 * Merge a single API page batch entry into the accumulator map.
 */
function mergePageIntoMap(pageMap: Map<string | number, ReportPage>, page: ReportPage): void {
	const key = page.pageid ?? page.title;
	const existing = pageMap.get(key);
	if (!existing) {
		pageMap.set(key, {
			...page,
			categories: page.categories ? [...page.categories] : undefined,
		});
		return;
	}
	if (!existing.revisions && page.revisions) {
		existing.revisions = page.revisions;
	}
	if (page.categories?.length) {
		existing.categories = [...existing.categories || [], ...page.categories];
	}
}

/**
 * Collect and merge paginated generator pages by pageid/title so multi-batch
 * `clcontinue` responses neither duplicate rows nor drop categories.
 */
async function collectPages(api: MediaWikiApi, params: MwApiParams): Promise<ReportPage[]> {
	const pageMap = new Map<string | number, ReportPage>();
	for await (const data of paginate<{ query?: { pages?: Record<string, ReportPage> } }>(api, params)) {
		for (const page of Object.values(data?.query?.pages || {})) {
			mergePageIntoMap(pageMap, page);
		}
	}
	return [...pageMap.values()].filter((page) => page.revisions?.length);
}

interface BuildImproveReportOptions {
	pages: ReportPage[];
	overrideCategory: string[];
	header: string;
	templateSelector: string;
	emptyReason: string;
}

/**
 * Build a sortable wikitable report for pages with improvement templates.
 */
function buildImproveReport({
	pages,
	overrideCategory,
	header,
	templateSelector,
	emptyReason,
}: BuildImproveReportOptions): string {
	let text = `${header}\n\n{| class="wikitable sortable" width=100%\n|-\n! 序号 || 条目名 || 改进方向 || style="width:30%"|部分所属分类 || style="min-width:50px"|代码长度 || style="min-width:80px"|最后版本\n`;
	let count = 1;
	for (const page of pages) {
		const rev = page.revisions?.[0];
		if (!rev) {
			continue;
		}
		const { title, categories } = page;
		const { timestamp, content = '', size } = rev;
		const category = categories
			?.map(({ title: catTitle }) => catTitle)
			.filter((catTitle) => !overrideCategory.includes(catTitle))
			.map((catTitle) => `[[:${catTitle}]]`)
			.join('，')
			|| 'data-sort-value="*" | <i style="color:red;">无分类！</i>';
		const wikitext = Parser.parse(content.replaceAll('\n', ''));
		const value = wikitext.querySelector<Parser.TranscludeToken>(templateSelector)?.getValue() as Record<string, string | undefined> | undefined
			|| { 0: 'data-sort-value="*" | <i style="color:red;">找不到目标模板</i>' };
		const reason = Object.keys(value)
			.filter((key) => !Number.isNaN(Number(key)) && value[key]?.trim())
			.map((key) => value[key]?.trim())
			.join(' • ')
			|| emptyReason;
		const time = `${moment(timestamp).utcOffset('+08:00').format('YYYY-MM-DD HH:mm')} (CST)`;
		text += `|-\n| ${count} || [[${title}]] || ${reason} || ${category} || ${size} || ${time}\n`;
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
	const overrideCategory = parseOverrideCategories(await readData('overrideCategory.json'));
	const pages = await collectPages(api, queryParams);
	const text = buildImproveReport({
		pages,
		overrideCategory,
		header,
		templateSelector,
		emptyReason,
	});
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
