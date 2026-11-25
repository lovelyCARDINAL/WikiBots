import type { MediaWikiApi, MwApiParams } from 'wiki-saikou';
import mapLimit from '../utils/common/concurrency.ts';
import splitAndJoin from '../utils/common/splitAndJoin.ts';
import config from '../utils/core/config.ts';
import {
	cmapi,
	loadCache,
	REPORT_PAGEID,
	resolveMissingFiles,
	safePost,
	SIZE_LIMIT,
	sleep,
	zhapi,
	type CacheEntry,
} from '../utils/report/brokenFileClient.ts';
import {
	buildIndexText,
	CATEGORY,
	groupByType,
	packVolumes,
	renderBlock,
	TYPE_ORDER,
	volumeText,
	volumeTitle,
	type PageFileEntry,
	type VolumeStat,
} from '../utils/report/brokenFileFormat.ts';
import {
	bytes,
	editPage,
	getIndexTitle,
	pushData,
} from '../utils/report/brokenFileStore.ts';

const BATCH_SIZE = 50;
const BATCH_CONCURRENCY = 3;
const GCM_LIMIT = 500;
const MAX_ROUNDS = 2000;
const NAMESPACES = '0|4|10|12|114|116';
const TITLE_FILTER = /sandbox|沙盒|页面格式/i;
const PER_PAGE_OVERHEAD = 4_000;
const EDIT_INTERVAL = 1_000;

interface PlanItem {
	title: string;
	type: string;
	text: string;
}

interface CollectPage {
	pageid: number;
	title?: string;
	ns: number;
	images?: Array<{ title: string }>;
}

interface ProcessBatchOptions {
	pages: CollectPage[];
	round: number;
	seenPages: number;
	imgData: Record<string, string>;
	cache: Record<string, CacheEntry>;
	queried: Set<string>;
	pageData: Record<number, PageFileEntry>;
}

async function processCategoryBatch({
	pages,
	round,
	seenPages,
	imgData,
	cache,
	queried,
	pageData,
}: ProcessBatchOptions): Promise<void> {
	const pagelist = pages.filter(
		(page): page is CollectPage & { title: string; images: Array<{ title: string }> } => Boolean(page.title && page.images && !TITLE_FILTER.test(page.title)),
	);
	if (!pagelist.length) {
		console.log(`第 ${round} 轮：本批 ${pages.length} 页全部被过滤，继续翻页`);
		return;
	}

	const imageTitles = [...new Set(pagelist.flatMap(({ images }) => images.map(({ title }) => title)))]
		.filter((title) => !queried.has(title));
	const groups = splitAndJoin(imageTitles, BATCH_SIZE);
	console.log(`第 ${round} 轮：本批 ${pages.length} 页（有效 ${pagelist.length}） / 待查文件 ${imageTitles.length} / ${groups.length} 组 / 累计 ${seenPages} 页`);

	await mapLimit(groups, BATCH_CONCURRENCY, (titles) => resolveMissingFiles(titles, imgData, cache));
	imageTitles.forEach((title) => queried.add(title));

	for (const { pageid, title, ns, images } of pagelist) {
		pageData[pageid] ||= { title, ns, images: {} };
		for (const { title: imageTitle } of images) {
			if (imgData[imageTitle]) {
				pageData[pageid].images[imageTitle] = imgData[imageTitle];
			}
		}
	}
}

async function collect(zhapi_: MediaWikiApi, imgData: Record<string, string>, cache: Record<string, CacheEntry>): Promise<Record<number, PageFileEntry>> {
	const pageData: Record<number, PageFileEntry> = {};
	const queried = new Set<string>();
	let cont: MwApiParams = {};
	let lastToken = '';
	let round = 0;
	let seenPages = 0;

	for (;;) {
		if (++round > MAX_ROUNDS) {
			console.warn(`WARN: 分页超过 ${MAX_ROUNDS} 轮，提前终止`);
			break;
		}
		const { data } = await safePost<{
			query?: { pages?: Record<string, CollectPage> };
		}>(zhapi_, {
			prop: 'images',
			generator: 'categorymembers',
			imlimit: 'max',
			gcmtitle: CATEGORY,
			gcmnamespace: NAMESPACES,
			gcmlimit: String(GCM_LIMIT),
			gcmsort: 'timestamp',
			gcmdir: 'older',
			...cont,
		}, { label: `categorymembers#${round}` });

		const nextCont = data.continue ?? null;
		const pages = Object.values(data.query?.pages ?? {});
		seenPages += pages.length;
		await processCategoryBatch({ pages, round, seenPages, imgData, cache, queried, pageData });

		if (!nextCont) {
			console.log(`分页结束，共 ${round} 轮 / 遍历 ${seenPages} 个页面`);
			break;
		}
		const token = JSON.stringify(nextCont);
		if (token === lastToken) {
			console.warn(`WARN: continue 令牌未变化，终止翻页：${token}`);
			break;
		}
		lastToken = token;
		cont = nextCont;
	}

	console.log(`汇总：${Object.keys(pageData).length} 个页面含受损文件，共 ${Object.keys(imgData).length} 个受损文件`);
	return pageData;
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	await Promise.all([
		zhapi.login(config.zh.ibot.name, config.zh.ibot.password, undefined, { retry: 25, noCache: true })
			.then((r) => console.log('zh login:', r)),
		cmapi.login(config.cm.ibot.name, config.cm.ibot.password, undefined, { retry: 25, noCache: true })
			.then((r) => console.log('cm login:', r)),
	]);

	const cache = await loadCache();
	console.log(`已加载 ${Object.keys(cache).length} 条历史缓存`);

	const imgData: Record<string, string> = {};
	const pageData = await collect(zhapi, imgData, cache);

	const payload: Record<string, CacheEntry> = {};
	for (const [title, status] of Object.entries(imgData)) {
		payload[title] = { status, time: cache[title]?.status === status ? cache[title].time ?? new Date().toISOString() : new Date().toISOString() };
	}

	try {
		console.log(await pushData(payload) ? '数据提交 SUCCESS!' : '数据提交 SKIP');
	} catch (error) {
		console.error('ERROR: 数据提交失败:', error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}

	console.log('\n开始拆分报告：');
	const indexTitle = await getIndexTitle();
	console.log(`索引页：${indexTitle}`);

	const groups = groupByType(pageData);
	const capacity = SIZE_LIMIT - PER_PAGE_OVERHEAD;
	const plan: PlanItem[] = [];
	const stats: VolumeStat[] = [];
	let totalFiles = 0;

	for (const type of TYPE_ORDER) {
		const rows = groups.get(type)!;
		const files = rows.reduce((n, row) => n + row.files.length, 0);
		if (!rows.length) {
			stats.push({ type, files: 0, pages: 0, volumes: [] });
			continue;
		}
		const volumes = packVolumes(rows.map(renderBlock), capacity);
		const titles = volumes.map((_, i) => volumeTitle(type, i + 1, volumes.length));
		volumes.forEach((vol, i) => plan.push({
			title: titles[i],
			type,
			text: volumeText({ type, index: i + 1, total: volumes.length, blocks: vol, indexTitle }),
		}));
		stats.push({ type, files, pages: rows.length, volumes: titles });
		totalFiles += files;
		const sizes = volumes.map((vol) => bytes(vol.join(''))).join(' / ');
		console.log(`  ${type}：${files} 个文件 / ${rows.length} 个页面 → ${volumes.length} 卷（净表格 ${sizes} 字节）`);
	}

	const totalPages = Object.values(pageData).filter((p) => Object.keys(p.images).length).length;
	console.log(`合计：${totalPages} 个页面 / ${totalFiles} 个受损文件 / ${plan.length} 个子页`);

	let failures = 0;
	for (const item of plan) {
		const ok = await editPage({
			title: item.title,
			text: item.text,
			summary: `更新受损文件报告（${item.type}）`,
		});
		if (!ok) {
			failures++;
		}
		await sleep(EDIT_INTERVAL);
	}

	if (!await editPage({
		pageid: REPORT_PAGEID,
		text: buildIndexText({ stats, totalPages, totalFiles }),
		summary: '更新受损文件报告索引',
	})) {
		failures++;
	}

	if (failures) {
		console.error(`\n共 ${failures} 个页面编辑失败`);
		process.exitCode = 1;
	} else {
		console.log('\n全部页面写入成功');
	}

	console.log(`End time: ${new Date().toISOString()}`);
})().catch((error) => {
	console.error('FATAL:', error);
	process.exitCode = 1;
});
