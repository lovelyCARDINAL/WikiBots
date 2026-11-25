import type { MediaWikiApi, MwApiParams } from 'wiki-saikou';
import mapLimit from '../utils/common/concurrency.ts';
import splitAndJoin from '../utils/common/splitAndJoin.ts';
import config from '../utils/core/config.ts';
import {
	bytes,
	cmapi,
	editPage,
	getIndexTitle,
	loadCache,
	pushData,
	REPORT_PAGEID,
	resolveMissingFiles,
	safePost,
	SIZE_LIMIT,
	sleep,
	zhapi,
	type CacheEntry,
} from '../utils/report/brokenFileClient.ts';

const BATCH_SIZE = 50;
const BATCH_CONCURRENCY = 3;
const GCM_LIMIT = 500;
const MAX_ROUNDS = 2000;
const CATEGORY = 'Category:含有受损文件链接的页面';
const NAMESPACES = '0|4|10|12|114|116';
const TITLE_FILTER = /sandbox|沙盒|页面格式/i;
const SUBPAGE_PREFIX = '萌娘百科:受损文件详细信息';
const PER_PAGE_OVERHEAD = 4_000;
const EDIT_INTERVAL = 1_000;

const FILE_TYPES = [
	{ key: '图像', ext: ['png', 'gif', 'jpg', 'jpeg', 'webp', 'svg', 'jp2'] },
	{ key: '音频', ext: ['mp3', 'ogg', 'oga', 'flac', 'opus', 'wav', 'midi', 'mid'] },
	{ key: '视频', ext: ['webm', 'ogv', 'mpg', 'mpeg'] },
	{ key: '文档', ext: ['pdf'] },
	{ key: '字体', ext: ['ttf', 'woff2'] },
	{ key: '其他', ext: [] },
];
const TYPE_ORDER = FILE_TYPES.map(({ key }) => key);
const EXT_TO_TYPE = new Map(FILE_TYPES.flatMap(({ key, ext }) => ext.map((e) => [e, key])));

interface PageFileEntry {
	title: string;
	ns: number;
	images: Record<string, string>;
}

interface BrokenFileRow {
	title: string;
	ns: number;
	files: Array<{ name: string; status: string }>;
}

interface VolumeStat {
	type: string;
	files: number;
	pages: number;
	volumes: string[];
}

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

async function processCategoryBatch(
	pages: CollectPage[],
	round: number,
	seenPages: number,
	imgData: Record<string, string>,
	cache: Record<string, CacheEntry>,
	queried: Set<string>,
	pageData: Record<number, PageFileEntry>,
): Promise<void> {
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

/** 分页拉取「含有受损文件链接的页面」分类成员及其图片 */
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
		await processCategoryBatch(pages, round, seenPages, imgData, cache, queried, pageData);

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

/* ==========================================================================
 * 报告拆分与生成
 * ======================================================================== */

const TIME_LOCAL = '{{subst:#time:Y年n月j日 (D) H:i (T)}}';
const TIME_UTC = '{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}';

/** 子页标题：单卷不带序号，多卷带 " 1 / 2 / 3" */
const volumeTitle = (type: string, index: number, total: number): string => total > 1
	? `${SUBPAGE_PREFIX}/${type} ${index}`
	: `${SUBPAGE_PREFIX}/${type}`;

/** 从文件标题提取扩展名并归类；识别不了的一律进「其他」 */
function typeOf(fileTitle: string): string {
	const name = String(fileTitle).replace(/^(?:File|Image|Media|文件|图像|媒体)\s*:\s*/i, '');
	const dot = name.lastIndexOf('.');
	if (dot < 0 || dot === name.length - 1) {return '其他';}
	return EXT_TO_TYPE.get(name.slice(dot + 1).toLowerCase()) ?? '其他';
}

/**
 * 按「文件类型」重组数据。
 * 同一页面若同时有受损图像和受损音频，会分别出现在两个类别的子页里，
 * 便于不同类型由不同人分工修复。
 */
function groupByType(pageData: Record<number, PageFileEntry>): Map<string, BrokenFileRow[]> {
	const perType = new Map<string, Map<string, BrokenFileRow>>(TYPE_ORDER.map((key) => [key, new Map()]));
	for (const { title, ns, images } of Object.values(pageData)) {
		for (const [name, status] of Object.entries(images)) {
			const bucket = perType.get(typeOf(name))!;
			if (!bucket.has(title)) {bucket.set(title, { title, ns, files: [] });}
			bucket.get(title)!.files.push({ name, status });
		}
	}
	const sorted = new Map<string, BrokenFileRow[]>();
	for (const key of TYPE_ORDER) {
		const rows = [...perType.get(key)!.values()];
		rows.forEach((row) => row.files.sort((a, b) => a.name.localeCompare(b.name, 'zh')));
		rows.sort((a, b) => a.ns - b.ns || a.title.localeCompare(b.title, 'zh'));
		sorted.set(key, rows);
	}
	return sorted;
}

/** 渲染一个页面在表格中占的整块 wikitext（含 rowspan），这是装箱的最小单位 */
function renderBlock({ title, ns, files }: BrokenFileRow): string {
	const rowspan = files.length;
	const namespace = `data-sort-value="${ns}"|${ns === 0 ? '（主）' : `{{ns:${ns}}}`}`;
	const results = files.map(({ name, status }) => `|[[cm:${name}|${name}]]||${status}\n|-`).join('\n');
	return rowspan === 1
		? `|[[${title}]]\n|${namespace}\n${results}\n`
		: `|rowspan=${rowspan}|[[${title}]]\n|rowspan=${rowspan} ${namespace}\n${results}\n`;
}

/** 贪心顺序装箱：以「页面块」为单位切卷，绝不在一个页面的表格中间断开 */
function packVolumes(blocks: string[], capacity: number): string[][] {
	const volumes: string[][] = [];
	let current: string[] = [];
	let size = 0;
	for (const block of blocks) {
		const len = bytes(block);
		if (len > capacity) {
			console.warn(`  ! 单个页面块即有 ${len} 字节，超过单卷容量 ${capacity}，将独占一卷（可能被 contenttoobig 拒绝）`);
		}
		if (current.length && size + len > capacity) {
			volumes.push(current);
			current = [];
			size = 0;
		}
		current.push(block);
		size += len;
	}
	if (current.length) {volumes.push(current);}
	return volumes.length ? volumes : [ [] ];
}

/** 单个分卷子页的 wikitext */
function volumeText({ type, index, total, blocks, indexTitle }: { type: string; index: number; total: number; blocks: string[]; indexTitle: string }): string {
	const nav: string[] = [];
	if (index > 1) {nav.push(`[[${volumeTitle(type, index - 1, total)}|← 上一卷]]`);}
	nav.push(`[[${indexTitle}|报告索引]]`);
	if (index < total) {nav.push(`[[${volumeTitle(type, index + 1, total)}|下一卷 →]]`);}

	return `* 本页面为[[U:星海-interfacebot|机器人]]生成的[[:${CATEGORY}|受损文件]]详细信息（'''${type}'''${total > 1 ? `，第 ${index}/${total} 卷` : ''}），完成修复的<b>任何用户</b>都可以<b class="plainlinks">[{{fullurl:{{FULLPAGENAME}}|action=edit}} 编辑下方表格]</b>。
* 生成时间：${TIME_LOCAL}｜${TIME_UTC}
* ${nav.join(' ｜ ')}

{| class="wikitable sortable plainlinks" style="word-break:break-all" width=100%
|-
! 页面名 || 命名空间 || 文件名 || 文件状态
|-
${blocks.join('')}|}
[[Category:萌娘百科数据报告]][[Category:积压工作]]`;
}

/** 索引页 wikitext */
function buildIndexText({ stats, totalPages, totalFiles }: { stats: VolumeStat[]; totalPages: number; totalFiles: number }): string {
	let text = `* 本页面为[[U:星海-interfacebot|机器人]]生成的[[:${CATEGORY}|受损文件]]报告'''索引'''。因单页大小限制（${Math.round(SIZE_LIMIT / 1000)} KB），明细已按文件类型拆分至下列子页面。
* 生成时间：${TIME_LOCAL}｜${TIME_UTC}
* 合计：'''${totalPages}''' 个页面、'''${totalFiles}''' 个受损文件。

{| class="wikitable sortable"
|-
! 文件类型 || 受损文件数 || 涉及页面数 || 分卷 || 明细子页面
|-
`;
	for (const { type, files, pages, volumes } of stats) {
		if (!volumes.length) {continue;}
		const links = volumes.length === 1
			? `[[${volumes[0]}|${type}]]`
			: volumes.map((v, i) => `[[${v}|${i + 1}]]`).join(' · ');
		text += `| ${type} || ${files} || ${pages} || ${volumes.length} || ${links}\n|-\n`;
	}
	text += `|}
[[Category:萌娘百科数据报告]][[Category:积压工作]]`;
	return text;
}

/* ==========================================================================
 * 主流程
 * ======================================================================== */

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

	// 未变化的条目保留原时间戳，便于后续做 TTL
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

	/* ---------- 按文件类型拆分成多个子页 ---------- */
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

	/* ---------- 顺序写入子页（避免并发触发限流） ---------- */
	let failures = 0;
	for (const item of plan) {
		const ok = await editPage({
			title: item.title,
			text: item.text,
			summary: `更新受损文件报告（${item.type}）`,
		});
		if (!ok) {failures++;}
		await sleep(EDIT_INTERVAL);
	}

	/* ---------- 最后写索引页，保证索引与实际存在的子页一致 ---------- */
	if (!await editPage({
		pageid: REPORT_PAGEID,
		text: buildIndexText({ stats, totalPages, totalFiles }),
		summary: '更新受损文件报告索引',
	})) {failures++;}

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
