import { Buffer } from 'buffer';
import { env } from 'process';
import { Octokit } from '@octokit/core';
import { MediaWikiApi, type MwApiParams } from 'wiki-saikou';
import mapLimit from '../common/concurrency.ts';
import readData from '../common/readData.ts';
import config from '../core/config.ts';

export const DETAIL_CONCURRENCY = 3;
export const MAX_RETRIES = 8;
export const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
export const REPORT_PAGEID = '555599';
export const SIZE_LIMIT = 500_000;

const GH_OWNER = 'lovelyCARDINAL';
const GH_REPO = 'WikiBots';
const GH_PATH = 'data/brokenFiles.json';
const RESTORE_PREFIX = 'https://commons.moegirl.org.cn/Special:恢复被删页面/';
const RETRYABLE_CODES = new Set(['maxlag', 'ratelimited', 'internal_api_error']);

export const zhapi = new MediaWikiApi({
	baseURL: config.zh.api,
	fexiosConfigs: { headers: { 'user-agent': config.useragent } },
});

export const cmapi = new MediaWikiApi({
	baseURL: config.cm.api,
	fexiosConfigs: { headers: { 'user-agent': config.useragent } },
});

const octokit = new Octokit({ auth: env.GITHUB_TOKEN });

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
export const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

export interface CacheEntry {
	status: string;
	time: string | null;
}

function validateApiResponse(data: { error?: { code?: string; info?: string; text?: string }; query?: unknown } | undefined, requireQuery: boolean): Error | null {
	if (data?.error) {
		const { code = '' } = data.error;
		const info = data.error.info ?? data.error.text ?? '';
		const err = new Error(`API error [${code}] ${info}`);
		if (!RETRYABLE_CODES.has(code)) {
			throw err;
		}
		return err;
	}
	if (requireQuery && !data?.query) {
		return new Error(`响应缺少 query 字段: ${JSON.stringify(data).slice(0, 200)}`);
	}
	return null;
}

/**
 * 统一的 POST 封装：捕获网关纯文本错误、网络抖动、5xx 与可重试 API error，做指数退避。
 */
export async function safePost<T = Record<string, unknown>>(
	api: MediaWikiApi,
	params: MwApiParams,
	{ requireQuery = true, retries = MAX_RETRIES, label = '' }: { requireQuery?: boolean; retries?: number; label?: string } = {},
) {
	let lastError: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const res = await api.post<T>(params, { retry: 3, noCache: true });
			const retryableErr = validateApiResponse(res?.data, requireQuery);
			if (!retryableErr) {
				return res;
			}
			lastError = retryableErr;
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			if (errMsg.startsWith('API error [') && !Array.from(RETRYABLE_CODES).some((c) => errMsg.includes(`[${c}]`))) {
				throw error;
			}
			lastError = error;
		}
		if (attempt === retries) {
			break;
		}
		const wait = Math.min(2 ** attempt * 1000 + Math.random() * 500, 30_000);
		console.warn(`  ! ${label} 第 ${attempt + 1}/${retries} 次重试，${Math.round(wait)}ms 后：${lastError instanceof Error ? lastError.message : String(lastError)}`);
		await sleep(wait);
	}
	throw lastError;
}

const restoreLink = (title: string): string => `${RESTORE_PREFIX}${encodeURIComponent(title.replaceAll(' ', '_'))}`;
const sysopRestore = (title: string, reason: string): string => `${reason}（[${restoreLink(title)} 恢复]）`;

export async function loadCache(): Promise<Record<string, CacheEntry>> {
	let raw: string;
	try {
		raw = await readData('brokenFiles.json');
	} catch (error) {
		console.warn(`WARN: 读取本地缓存失败，按空缓存继续：${error instanceof Error ? error.message : String(error)}`);
		return {};
	}
	try {
		const parsed = JSON.parse(raw) as Record<string, string | CacheEntry> | null;
		const cache: Record<string, CacheEntry> = {};
		for (const [title, value] of Object.entries(parsed ?? {})) {
			cache[title] = typeof value === 'string' ? { status: value, time: null } : value;
		}
		return cache;
	} catch {
		console.warn('WARN: brokenFiles.json 不是合法 JSON，按空缓存继续');
		return {};
	}
}

const cacheUsable = (entry?: CacheEntry): boolean => Boolean(
	entry?.status && CACHE_TTL && entry.time && Date.now() - new Date(entry.time).getTime() < CACHE_TTL,
);

async function getDetails(title: string): Promise<string> {
	let lecontinue: string | undefined;
	for (let round = 0; round < 5; round++) {
		const { data } = await safePost<{
			query?: { logevents?: Array<{ type: string; params?: { target_title?: string; title?: string } }> };
		}>(cmapi, {
			list: 'logevents',
			leprop: 'type|details',
			ledir: 'older',
			letitle: title,
			lelimit: 'max',
			...lecontinue && { lecontinue },
		}, { requireQuery: false, label: `logevents(${title})` });

		for (const { type, params } of data?.query?.logevents ?? []) {
			if (type === 'delete') {
				return sysopRestore(title, '被删除');
			}
			if (type === 'move') {
				const target = params?.target_title ?? params?.title;
				return target ? `被移动至[[:${target}]]` : '被移动（目标未知）';
			}
		}
		const nextContinue = data?.continue?.lecontinue;
		if (!nextContinue) {
			break;
		}
		lecontinue = nextContinue;
	}
	return '未知';
}

export async function resolveMissingFiles(titles: string, imgData: Record<string, string>, cache: Record<string, CacheEntry>): Promise<void> {
	interface MissingCheckPage {
		title: string;
		missing?: boolean | '';
		known?: boolean | '';
	}
	const { data } = await safePost<{
		query?: { pages?: Record<string, MissingCheckPage> };
	}>(cmapi, { prop: 'revisions', titles, rvprop: '' }, { label: `revisions(${titles.length})` });

	const missingPages = Object.values(data?.query?.pages ?? {}).filter((page) => page.missing === true || page.missing === '');

	await mapLimit(missingPages, DETAIL_CONCURRENCY, async ({ title, known }) => {
		const isKnown = known !== undefined && known !== false;
		const cached = cache[title];
		if (cacheUsable(cached)) {
			imgData[title] = cached.status;
			return;
		}
		try {
			imgData[title] = isKnown ? sysopRestore(title, '页面丢失') : await getDetails(title);
		} catch (error) {
			imgData[title] = cached?.status ?? '⚠️ 查询失败（下次运行会重试）';
			console.warn(`  ! ${title} 查询失败，使用兜底值：${error instanceof Error ? error.message : String(error)}`);
		}
	});
}

export async function pushData(imgData: Record<string, CacheEntry>): Promise<boolean> {
	if (!env.GITHUB_TOKEN) {
		console.warn('WARN: 未设置 GITHUB_TOKEN，跳过数据提交');
		return false;
	}
	const content = Buffer.from(JSON.stringify(imgData, null, '\t'), 'utf-8').toString('base64');

	for (let attempt = 0; attempt < 3; attempt++) {
		let sha: string | undefined;
		try {
			const res = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
				owner: GH_OWNER, repo: GH_REPO, path: GH_PATH,
			});
			sha = 'sha' in res.data ? res.data.sha : undefined;
		} catch (error: unknown) {
			if ((error as { status?: number } | undefined)?.status !== 404) {
				throw error;
			}
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
		} catch (error: unknown) {
			if ((error as { status?: number } | undefined)?.status === 409 && attempt < 2) {
				console.warn('提交冲突，重新获取 sha 后重试');
				await sleep(2000);
				continue;
			}
			throw error;
		}
	}
	return false;
}

export async function getIndexTitle(): Promise<string> {
	const { data } = await safePost<{
		query?: { pages?: Record<string, { missing?: boolean; title: string }> };
	}>(zhapi, { prop: 'info', pageids: REPORT_PAGEID }, { label: 'indexinfo' });
	const page = Object.values(data?.query?.pages ?? {})[0];
	if (!page || page.missing) {
		throw new Error(`索引页 pageid=${REPORT_PAGEID} 不存在，请检查 REPORT_PAGEID`);
	}
	return page.title;
}

async function getBaseRevId({ title, pageid }: { title?: string; pageid?: string }): Promise<number | undefined> {
	const { data } = await safePost<{
		query?: { pages?: Record<string, { missing?: boolean; revisions?: Array<{ revid: number }> }> };
	}>(zhapi, {
		prop: 'revisions',
		rvprop: 'ids',
		rvlimit: '1',
		...pageid ? { pageids: pageid } : { titles: title },
	}, { label: 'pageinfo' });
	const page = Object.values(data?.query?.pages ?? {})[0];
	return page && !page.missing ? page.revisions?.[0]?.revid : undefined;
}

export async function editPage({ title, pageid, text, summary }: { title?: string; pageid?: string; text: string; summary: string }): Promise<boolean> {
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
