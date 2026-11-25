import { MediaWikiApi, type MwApiParams } from 'wiki-saikou';
import mapLimit from '../common/concurrency.ts';
import readData from '../common/readData.ts';
import config from '../core/config.ts';

export const DETAIL_CONCURRENCY = 3;
export const MAX_RETRIES = 8;
export const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
export const REPORT_PAGEID = '555599';
export const SIZE_LIMIT = 500_000;

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

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
