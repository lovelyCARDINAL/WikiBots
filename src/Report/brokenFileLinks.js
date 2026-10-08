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
const BATCH_CONCURRENCY = 2;
/** 并发上限（单个文件的日志查询） */
const DETAIL_CONCURRENCY = 2;
/** 分类成员每批取多少页。max(=500/5000) 会让单批体积爆炸 */
const GCM_LIMIT = 100;
/** 应用层重试次数（覆盖 BODY_TRANSFORM_ERROR 这类 fexios 内部不重试的错误） */
const MAX_RETRIES = 8;
/** 分页最大轮数，防止 continue 异常导致死循环 */
const MAX_PAGES = 200;
/**
 * 文件状态缓存有效期（毫秒）。
 * 0 = 每轮都重新查询（推荐，避免报告长期显示过期状态）；
 * 只有查询失败时才回退到缓存值。
 * 若想省流量可设为 24 * 60 * 60 * 1000。
 */
const CACHE_TTL = 0;

/** 报告页面 pageid */
const REPORT_PAGEID = '555599';
/** GitHub 上的数据文件 */
const GH_OWNER = 'lovelyCARDINAL';
const GH_REPO = 'WikiBots';
const GH_PATH = 'data/brokenFiles.json';
/** Commons 侧恢复页面地址前缀 */
const RESTORE_PREFIX = 'https://commons.moegirl.org.cn/Special:恢复被删页面/';

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
				const { code, info } = data.error;
				const err = new Error(`API error [${code}] ${info ?? ''}`);
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

const sysopRestore = (title, reason) => `${reason}<span class='sysop-show'>（[${restoreLink(title)} 恢复]）</span>`;

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
		if (!data?.continue?.lecontinue) {break;}
		({ lecontinue } = data.continue);
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
	const missingPages = pages.filter((page) => page.missing);

	await mapLimit(missingPages, DETAIL_CONCURRENCY, async ({ title, known }) => {
		const cached = cache[title];
		if (cacheUsable(cached)) {
			imgData[title] = cached.status;
			return;
		}
		try {
			imgData[title] = known ? sysopRestore(title, '页面丢失') : await getDetails(title);
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
	const eol = Symbol('eol');
	let imcontinue;
	let round = 0;

	while (imcontinue !== eol) {
		if (++round > MAX_PAGES) {
			console.warn(`WARN: 分页超过 ${MAX_PAGES} 轮，提前终止`);
			break;
		}
		const { data } = await safePost(zhapi_, {
			prop: 'images',
			generator: 'categorymembers',
			imlimit: 'max',
			gcmtitle: 'Category:含有受损文件链接的页面',
			gcmnamespace: '0|4|10|12',
			gcmlimit: String(GCM_LIMIT),
			gcmsort: 'timestamp',
			gcmdir: 'older',
			...imcontinue && { imcontinue },
		}, { label: `categorymembers#${round}` });

		imcontinue = data.continue?.imcontinue ?? eol;

		const pages = Object.values(data.query?.pages ?? {});
		const pagelist = pages.filter(
			(page) => page.title && page.images && !/sandbox|沙盒|页面格式/i.test(page.title),
		);
		if (!pagelist.length) {continue;}

		// 去重后分批查询，避免同一文件被重复请求
		const imageTitles = [...new Set(pagelist.flatMap(({ images }) => images.map(({ title }) => title)))].filter((title) => !queried.has(title));
		const groups = splitAndJoin(imageTitles, BATCH_SIZE);
		console.log(`第 ${round} 批：${pagelist.length} 个页面 / ${imageTitles.length} 个待查文件 / ${groups.length} 组`);

		await mapLimit(groups, BATCH_CONCURRENCY, (titles) => resolveMissingFiles(titles, imgData, cache));
		imageTitles.forEach((title) => queried.add(title));

		for (const { pageid, title, ns, images } of pagelist) {
			pageData[pageid] ||= { title, ns, images: {} };
			for (const { title: imageTitle } of images) {
				if (imgData[imageTitle]) {pageData[pageid].images[imageTitle] = imgData[imageTitle];}
			}
		}
	}

	return pageData;
}

/** 生成 wikitext 报告 */
function buildText(pageData) {
	const now = '{{subst:#time:Y年n月j日 (D) H:i (T)}}';
	let text = `* 本页面为[[U:星海-interfacebot|机器人]]生成的[[:Category:含有受损文件链接的页面|受损文件]]详细信息，完成修复的<b>任何用户</b>都可以<b class="plainlinks">[{{fullurl:{{FULLPAGENAME}}|action=edit}} 编辑下方表格]</b>。
* 生成时间：${now}｜${now.replace('}}', '|||1}}')}

{| class="wikitable sortable plainlinks" style="word-break:break-all" width=100%
|-
! 页面名 || 命名空间 || 文件名 || 文件状态
|-
`;

	let rows = 0;
	for (const { title, ns, images } of Object.values(pageData)) {
		const names = Object.keys(images);
		const rowspan = names.length;
		if (!rowspan) {continue;}
		rows += rowspan;

		const namespace = `data-sort-value="${ns}"|${ns === 0 ? '（主）' : `{{ns:${ns}}}`}`;
		const results = names.map((name) => `|[[cm:${name}|${name}]]||${images[name]}\n|-`).join('\n');
		text += rowspan === 1
			? `|[[${title}]]\n|${namespace}\n${results}\n`
			: `|rowspan=${rowspan}|[[${title}]]\n|rowspan=${rowspan} ${namespace}\n${results}\n`;
	}
	text += '|}\n[[Category:萌娘百科数据报告]][[Category:积压工作]]';
	console.log(`报告：${Object.keys(pageData).length} 个页面 / ${rows} 条受损文件记录`);
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

/** 编辑报告页，带 baserevid 冲突检测与重试 */
async function editReport(text) {
	for (let attempt = 0; attempt < 3; attempt++) {
		const { data: info } = await safePost(zhapi, {
			prop: 'revisions',
			pageids: REPORT_PAGEID,
			rvprop: 'ids',
			rvlimit: '1',
		}, { label: 'pageinfo' });
		const baserevid = Object.values(info?.query?.pages ?? {})[0]?.revisions?.[0]?.revid;

		const { data } = await zhapi.postWithToken('csrf', {
			action: 'edit',
			pageid: REPORT_PAGEID,
			text,
			summary: '更新数据报告',
			bot: true,
			notminor: true,
			tags: 'Bot',
			watchlist: 'nochange',
			...baserevid && { baserevid },
			starttimestamp: Math.floor(Date.now() / 1000),
		}, { retry: 5, noCache: true });

		const result = data?.edit?.result;
		if (result === 'Success') {
			console.log(`编辑成功：${data.edit.newrevid ?? ''}`);
			return true;
		}
		if (data?.error?.code === 'editconflict' && attempt < 2) {
			console.warn('检测到编辑冲突，重新读取 baserevid 后重试');
			await sleep(3000);
			continue;
		}
		console.error('编辑未成功：', JSON.stringify(data));
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
		console.log(await pushData(payload, cache) ? '数据提交 SUCCESS!' : '数据提交 SKIP');
	} catch (error) {
		console.error('ERROR: 数据提交失败:', error.message);
		process.exitCode = 1;
	}

	if (!Object.keys(pageData).length) {
		console.log('本轮无受损文件，跳过页面编辑');
	} else if (!await editReport(buildText(pageData))) {
		process.exitCode = 1;
	}

	console.log(`End time: ${new Date().toISOString()}`);
})().catch((error) => {
	console.error('FATAL:', error);
	process.exitCode = 1;
});
