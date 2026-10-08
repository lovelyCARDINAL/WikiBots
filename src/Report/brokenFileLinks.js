import { Buffer } from 'buffer';
import { env } from 'process';
import { Octokit } from '@octokit/core';
import { MediaWikiApi } from 'wiki-saikou';
import config from '../utils/config.js';
import readData from '../utils/readData.js';
import splitAndJoin from '../utils/splitAndJoin.js';

/* ==========================================================================
 * 可调参数
 * ======================================================================== */

/** 单次 revisions 查询携带的文件标题数。500 太重，容易被网关 503 掉 */
const BATCH_SIZE = 50;
/** 并发上限（外层批次） */
const BATCH_CONCURRENCY = 3;
/** 并发上限（单个文件的日志查询） */
const DETAIL_CONCURRENCY = 3;
/** 分类成员每批取多少页。max(=500/5000) 会让单批体积爆炸 */
const GCM_LIMIT = 500;
/** 应用层重试次数（覆盖 BODY_TRANSFORM_ERROR 这类 fexios 内部不重试的错误） */
const MAX_RETRIES = 8;
/** 分页最大轮数，防止 continue 异常导致死循环（5400 页 / 100 ≈ 54 轮，留足余量） */
const MAX_ROUNDS = 2000;

/** 目标分类与命名空间 */
const CATEGORY = 'Category:含有受损文件链接的页面';
const NAMESPACES = '0|4|10|12|114|116';
/** 标题过滤（沙盒、格式说明页不计入报告） */
const TITLE_FILTER = /sandbox|沙盒|页面格式/i;
/**
 * 文件状态缓存有效期（毫秒）。
 * 0 = 每轮都重新查询（推荐，避免报告长期显示过期状态）；
 * 只有查询失败时才回退到缓存值。
 */
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;

/** 报告索引页 pageid（沿用原页面，避免站内既有链接失效） */
const REPORT_PAGEID = '555599';
/** 子页面前缀：各类别分卷页面都建在它下面 */
const SUBPAGE_PREFIX = '萌娘百科:受损文件详细信息';
/** 单个子页 wikitext 的字节上限（MediaWiki 硬限制 2048KB=2097152，这里按你的要求压到 100 万） */
const SIZE_LIMIT = 500_000;
/** 为表头/表尾/导航预留的字节数，装箱时从 SIZE_LIMIT 中扣除 */
const PER_PAGE_OVERHEAD = 4_000;
/** 连续编辑子页的间隔（毫秒），避免触发 ratelimit */
const EDIT_INTERVAL = 1_000;

/** GitHub 上的数据文件 */
const GH_OWNER = 'lovelyCARDINAL';
const GH_REPO = 'WikiBots';
const GH_PATH = 'data/brokenFiles.json';
/** Commons 侧恢复页面地址前缀 */
const RESTORE_PREFIX = 'https://commons.moegirl.org.cn/Special:恢复被删页面/';

/**
 * 是否改用模板生成"恢复"链接。
 * 内联写法每条约 130~200 字节（文件名含中文时 URL 编码后一个字 9 字节），
 * 换成 {{模板|文件名}} 可省掉三到五成体积。需先在站内建好模板：
 *   <span class='sysop-show'>（[https://commons.moegirl.org.cn/Special:恢复被删页面/{{urlencode:{{{1}}}}} 恢复]）</span>
 */

/**
 * 文件类型分类。顺序即索引页与子页的排列顺序，"其他"必须放最后作为兜底。
 * 扩展名按 MediaWiki 实际支持的格式整理，可自行增删。
 */
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

/* ==========================================================================
 * 初始化
 * ======================================================================== */

const zhapi = new MediaWikiApi({
		baseURL: config.zh.api,
		fexiosConfigs: {
			headers: { 'user-agent': config.useragent },
		},
	}),
	cmapi = new MediaWikiApi({
		baseURL: config.cm.api,
		fexiosConfigs: {
			headers: { 'user-agent': config.useragent },
		},
	});

const octokit = new Octokit({ auth: env.GITHUB_TOKEN });

/* ==========================================================================
 * 通用工具
 * ======================================================================== */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 带指数退避的并发闸门。
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, fn) {
	const results = new Array(items.length);
	let cursor = 0;
	const worker = async () => {
		while (cursor < items.length) {
			const index = cursor++;
			results[index] = await fn(items[index], index);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
	return results;
}

/**
 * 统一的 POST 封装：
 * - 捕获 BODY_TRANSFORM_ERROR（网关返回 "upstream connect error..." 纯文本时 fexios 不会自动重试）
 * - 捕获网络抖动 / 5xx / API error，做指数退避
 * - 返回体缺少 data.query 时视为可重试错误
 * @param {MediaWikiApi} api
 * @param {Record<string, unknown>} params
 * @param {{ requireQuery?: boolean, retries?: number, label?: string }} [options]
 */
async function safePost(api, params, { requireQuery = true, retries = MAX_RETRIES, label = '' } = {}) {
	let lastError;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const res = await api.post(params, { retry: 3, noCache: true });
			const data = res?.data;
			if (data?.error) {
				// maxlag / ratelimited 这类值得重试；其它 API error 直接抛
				const { code } = data.error;
				const err = new Error(`API error [${code}] ${data.error.info ?? ''}`);
				if (code === 'maxlag' || code === 'ratelimited' || code === 'internal_api_error') {
					lastError = err;
				} else {
					throw err;
				}
			} else if (requireQuery && !data?.query) {
				lastError = new Error(`响应缺少 query 字段: ${JSON.stringify(data).slice(0, 200)}`);
			} else {
				return res;
			}
		} catch (error) {
			// 明确不可重试的错误直接向上抛
			if (error?.message?.startsWith('API error [') && !['maxlag', 'ratelimited', 'internal_api_error']
				.some((c) => error.message.includes(`[${c}]`))) {
				throw error;
			}
			lastError = error;
		}
		if (attempt === retries) {break;}
		const wait = Math.min(2 ** attempt * 1000 + Math.random() * 500, 30_000);
		console.warn(`  ! ${label} 第 ${attempt + 1}/${retries} 次重试，${Math.round(wait)}ms 后：${lastError?.message ?? lastError}`);
		await sleep(wait);
	}
	throw lastError;
}

/** 生成恢复被删页面链接（做 URL 编码，避免文件名含 # % & 时链接损坏） */
const restoreLink = (title) => `${RESTORE_PREFIX}${encodeURIComponent(title.replaceAll(' ', '_'))}`;

const sysopRestore = (title, reason) => `${reason}（[${restoreLink(title)} 恢复]）`;

/* ==========================================================================
 * 缓存读写（结构：{ [title]: { status, time } }，兼容旧的纯字符串格式）
 * ======================================================================== */

async function loadCache() {
	let raw;
	try {
		raw = await readData('brokenFiles.json');
	} catch (error) {
		console.warn(`WARN: 读取本地缓存失败，按空缓存继续：${error.message}`);
		return {};
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		console.warn('WARN: brokenFiles.json 不是合法 JSON，按空缓存继续');
		return {};
	}
	const cache = {};
	for (const [title, value] of Object.entries(parsed ?? {})) {
		cache[title] = typeof value === 'string' ? { status: value, time: null } : value;
	}
	return cache;
}

const cacheUsable = (entry) => {
	if (!entry?.status) {return false;}
	if (!CACHE_TTL) {return false;} // TTL=0 表示每轮都重查，缓存仅作失败兜底
	if (!entry.time) {return false;}
	return Date.now() - new Date(entry.time).getTime() < CACHE_TTL;
};

/* ==========================================================================
 * 业务逻辑
 * ======================================================================== */

/** 查询单个文件在 Commons 侧的删除 / 移动记录 */
async function getDetails(title) {
	let lecontinue;
	for (let round = 0; round < 5; round++) {
		const { data } = await safePost(cmapi, {
			list: 'logevents',
			leprop: 'type|details',
			ledir: 'older',
			letitle: title,
			lelimit: 'max',
			...lecontinue && { lecontinue },
		}, { requireQuery: false, label: `logevents(${title})` });

		const logevents = data?.query?.logevents ?? [];
		for (const { type, params } of logevents) {
			if (type === 'delete') {return sysopRestore(title, '被删除');}
			if (type === 'move') {
				const target = params?.target_title ?? params?.title;
				return target ? `被移动至[[:${target}]]` : '被移动（目标未知）';
			}
		}
		const { 'continue': { lecontinue: nextLecontinue } = {} } = data ?? {};
		if (!nextLecontinue) {break;}
		lecontinue = nextLecontinue;
	}
	return '未知';
}

/** 查询一批文件标题在 Commons 侧是否丢失，写入 imgData */
async function resolveMissingFiles(titles, imgData, cache) {
	const { data } = await safePost(cmapi, {
		prop: 'revisions',
		titles,
		rvprop: '',
	}, { label: `revisions(${titles.length})` });

	const pages = Object.values(data?.query?.pages ?? {});
	// formatversion=2 下 missing 为 true，formatversion=1 下为 ""，两者都算缺失
	const isMissing = (page) => page.missing === true || page.missing === '';
	const missingPages = pages.filter(isMissing);

	await mapLimit(missingPages, DETAIL_CONCURRENCY, async ({ title, known }) => {
		const isKnown = known !== undefined && known !== false; // 同样兼容两种 formatversion
		const cached = cache[title];
		if (cacheUsable(cached)) {
			imgData[title] = cached.status;
			return;
		}
		try {
			imgData[title] = isKnown ? sysopRestore(title, '页面丢失') : await getDetails(title);
		} catch (error) {
			// 单个文件查询失败不应毁掉整轮任务
			imgData[title] = cached?.status ?? '⚠️ 查询失败（下次运行会重试）';
			console.warn(`  ! ${title} 查询失败，使用兜底值：${error.message}`);
		}
	});
}

/** 分页拉取「含有受损文件链接的页面」分类成员及其图片 */
async function collect(zhapi_, imgData, cache) {
	const pageData = {};
	const queried = new Set(); // 跨分页轮次去重，避免同一文件被反复查询
	let cont = {}; // 整个 continue 对象原样回传（含 gcmcontinue / imcontinue / continue 顺序标记）
	let lastToken = '';
	let round = 0;
	let seenPages = 0;

	for (;;) {
		if (++round > MAX_ROUNDS) {
			console.warn(`WARN: 分页超过 ${MAX_ROUNDS} 轮，提前终止`);
			break;
		}

		const { data } = await safePost(zhapi_, {
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

		// 先取续读令牌，再处理本批数据：即使本批被全部过滤掉，也不能中断翻页
		const nextCont = data.continue ?? null;

		const pages = Object.values(data.query?.pages ?? {});
		seenPages += pages.length;
		const pagelist = pages.filter(
			(page) => page.title && page.images && !TITLE_FILTER.test(page.title),
		);

		if (pagelist.length) {
			const imageTitles = [...new Set(pagelist.flatMap(({ images }) => images.map(({ title }) => title)))]
				.filter((title) => !queried.has(title));
			const groups = splitAndJoin(imageTitles, BATCH_SIZE);
			console.log(
				`第 ${round} 轮：本批 ${pages.length} 页（有效 ${pagelist.length}）`
        + ` / 待查文件 ${imageTitles.length} / ${groups.length} 组`
        + ` / 累计 ${seenPages} 页`,
			);

			await mapLimit(groups, BATCH_CONCURRENCY, (titles) => resolveMissingFiles(titles, imgData, cache));
			imageTitles.forEach((title) => queried.add(title));

			for (const { pageid, title, ns, images } of pagelist) {
				pageData[pageid] ||= { title, ns, images: {} };
				for (const { title: imageTitle } of images) {
					if (imgData[imageTitle]) {pageData[pageid].images[imageTitle] = imgData[imageTitle];}
				}
			}
		} else {
			console.log(`第 ${round} 轮：本批 ${pages.length} 页全部被过滤，继续翻页`);
		}

		if (!nextCont) {
			console.log(`分页结束，共 ${round} 轮 / 遍历 ${seenPages} 个页面`);
			break;
		}

		// 令牌未变化 = 服务端没往前推进，避免死循环
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

const bytes = (s) => Buffer.byteLength(s, 'utf8');

const TIME_LOCAL = '{{subst:#time:Y年n月j日 (D) H:i (T)}}';
const TIME_UTC = '{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}';

/** 子页标题：单卷不带序号，多卷带 " 1 / 2 / 3" */
const volumeTitle = (type, index, total) => total > 1
	? `${SUBPAGE_PREFIX}/${type} ${index}`
	: `${SUBPAGE_PREFIX}/${type}`;

/** 从文件标题提取扩展名并归类；识别不了的一律进「其他」 */
function typeOf(fileTitle) {
	const name = String(fileTitle).replace(/^(?:File|Image|Media|文件|图像|媒体)\s*:\s*/i, '');
	const dot = name.lastIndexOf('.');
	if (dot < 0 || dot === name.length - 1) {return '其他';}
	return EXT_TO_TYPE.get(name.slice(dot + 1).toLowerCase()) ?? '其他';
}

/**
 * 按「文件类型」重组数据。
 * 同一页面若同时有受损图像和受损音频，会分别出现在两个类别的子页里，
 * 便于不同类型由不同人分工修复。
 * @returns {Map<string, Array<{title: string, ns: number, files: Array<{name: string, status: string}>}>>}
 */
function groupByType(pageData) {
	const perType = new Map(TYPE_ORDER.map((key) => [key, new Map()]));
	for (const { title, ns, images } of Object.values(pageData)) {
		for (const [name, status] of Object.entries(images)) {
			const bucket = perType.get(typeOf(name));
			if (!bucket.has(title)) {bucket.set(title, { title, ns, files: [] });}
			bucket.get(title).files.push({ name, status });
		}
	}
	const sorted = new Map();
	for (const key of TYPE_ORDER) {
		const rows = [...perType.get(key).values()];
		rows.forEach((row) => row.files.sort((a, b) => a.name.localeCompare(b.name, 'zh')));
		rows.sort((a, b) => a.ns - b.ns || a.title.localeCompare(b.title, 'zh'));
		sorted.set(key, rows);
	}
	return sorted;
}

/** 渲染一个页面在表格中占的整块 wikitext（含 rowspan），这是装箱的最小单位 */
function renderBlock({ title, ns, files }) {
	const rowspan = files.length;
	const namespace = `data-sort-value="${ns}"|${ns === 0 ? '（主）' : `{{ns:${ns}}}`}`;
	const results = files.map(({ name, status }) => `|[[cm:${name}|${name}]]||${status}\n|-`).join('\n');
	return rowspan === 1
		? `|[[${title}]]\n|${namespace}\n${results}\n`
		: `|rowspan=${rowspan}|[[${title}]]\n|rowspan=${rowspan} ${namespace}\n${results}\n`;
}

/** 贪心顺序装箱：以「页面块」为单位切卷，绝不在一个页面的表格中间断开 */
function packVolumes(blocks, capacity) {
	const volumes = [];
	let current = [];
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
function volumeText({ type, index, total, blocks, indexTitle }) {
	const nav = [];
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
function buildIndexText({ stats, totalPages, totalFiles }) {
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

/** 提交数据文件到 GitHub；文件不存在时自动创建，sha 冲突时自动重试 */
async function pushData(imgData) {
	if (!env.GITHUB_TOKEN) {
		console.warn('WARN: 未设置 GITHUB_TOKEN，跳过数据提交');
		return false;
	}
	const content = Buffer.from(JSON.stringify(imgData, null, '\t'), 'utf-8').toString('base64');

	for (let attempt = 0; attempt < 3; attempt++) {
		let sha;
		try {
			({ data: { sha } } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
				owner: GH_OWNER, repo: GH_REPO, path: GH_PATH,
			}));
		} catch (error) {
			if (error.status !== 404) {throw error;}
			console.log('数据文件不存在，本次将创建');
		}

		try {
			await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
				owner: GH_OWNER,
				repo: GH_REPO,
				path: GH_PATH,
				message: 'auto: update broken files data',
				content,
				...sha && { sha },
			});
			return true;
		} catch (error) {
			// 409 = sha 冲突（别人刚提交过），重新取 sha 再试
			if (error.status === 409 && attempt < 2) {
				console.warn('提交冲突，重新获取 sha 后重试');
				await sleep(2000);
				continue;
			}
			throw error;
		}
	}
	return false;
}

/** 取索引页真实标题（子页导航与索引链接都要用） */
async function getIndexTitle() {
	const { data } = await safePost(zhapi, { prop: 'info', pageids: REPORT_PAGEID }, { label: 'indexinfo' });
	const page = Object.values(data?.query?.pages ?? {})[0];
	if (!page || page.missing) {throw new Error(`索引页 pageid=${REPORT_PAGEID} 不存在，请检查 REPORT_PAGEID`);}
	return page.title;
}

/** 读取页面当前 revid，用于编辑冲突检测；页面不存在时返回 undefined */
async function getBaseRevId({ title, pageid }) {
	const { data } = await safePost(zhapi, {
		prop: 'revisions',
		rvprop: 'ids',
		rvlimit: '1',
		...pageid ? { pageids: pageid } : { titles: title },
	}, { label: 'pageinfo' });
	const page = Object.values(data?.query?.pages ?? {})[0];
	return page && !page.missing ? page.revisions?.[0]?.revid : undefined;
}

/**
 * 通用编辑：支持按 pageid（索引页）或按 title（子页，不存在则自动创建）。
 * 兼容 formatversion 1 的 error{} 与 formatversion 2 的 errors[] 两种错误结构。
 */
async function editPage({ title, pageid, text, summary }) {
	const label = title ?? `pageid=${pageid}`;
	const size = bytes(text);
	if (size > SIZE_LIMIT) {
		console.warn(`  ! ${label} 体积 ${size} 字节，已超出软上限 ${SIZE_LIMIT}`);
	}

	for (let attempt = 0; attempt < 3; attempt++) {
		const baserevid = await getBaseRevId({ title, pageid });
		const { data } = await zhapi.postWithToken('csrf', {
			action: 'edit',
			...pageid ? { pageid } : { title },
			text,
			summary,
			bot: true,
			notminor: true,
			tags: 'Bot',
			watchlist: 'nochange',
			...baserevid && { baserevid },
			starttimestamp: Math.floor(Date.now() / 1000),
		}, { retry: 5, noCache: true });

		if (data?.edit?.result === 'Success') {
			console.log(`  ✓ ${label}（${size} 字节）→ revid ${data.edit.newrevid ?? ''}`);
			return true;
		}

		const code = data?.error?.code ?? data?.errors?.[0]?.code;
		const info = data?.error?.info ?? data?.errors?.[0]?.text ?? JSON.stringify(data).slice(0, 300);
		if (code === 'editconflict' && attempt < 2) {
			console.warn(`  ! ${label} 编辑冲突，重新取 baserevid 后重试`);
			await sleep(3000);
			continue;
		}
		if (code === 'ratelimited' && attempt < 2) {
			console.warn(`  ! ${label} 触发限流，15s 后重试`);
			await sleep(15_000);
			continue;
		}
		console.error(`  ✗ ${label} 编辑失败 [${code}] ${info}`);
		if (code === 'contenttoobig') {
			console.error(`    实际 ${size} 字节。可调小 SIZE_LIMIT / GCM_LIMIT 压缩体积`);
		}
		return false;
	}
	return false;
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

	const imgData = {};
	const pageData = await collect(zhapi, imgData, cache);

	// 未变化的条目保留原时间戳，便于后续做 TTL
	const payload = {};
	for (const [title, status] of Object.entries(imgData)) {
		payload[title] = { status, time: cache[title]?.status === status ? cache[title].time ?? new Date().toISOString() : new Date().toISOString() };
	}

	try {
		console.log(await pushData(payload) ? '数据提交 SUCCESS!' : '数据提交 SKIP');
	} catch (error) {
		console.error('ERROR: 数据提交失败:', error.message);
		process.exitCode = 1;
	}

	/* ---------- 按文件类型拆分成多个子页 ---------- */
	console.log('\n开始拆分报告：');
	const indexTitle = await getIndexTitle();
	console.log(`索引页：${indexTitle}`);

	const groups = groupByType(pageData);
	const capacity = SIZE_LIMIT - PER_PAGE_OVERHEAD;
	const plan = [];
	const stats = [];
	let totalFiles = 0;

	for (const type of TYPE_ORDER) {
		const rows = groups.get(type);
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
