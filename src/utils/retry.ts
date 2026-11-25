import process from 'process';
import type { MediaWikiApi, MwApiParams, MwTokenName } from 'wiki-saikou';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Execute an async API call with jittered exponential backoff for transient
 * Moegirlpedia gateway/network errors (including `fetch failed` and
 * `Failed to transform response body to json`).
 */
async function withRetry<T>(
	fn: () => Promise<T>,
	attempts = 25,
	label = 'API request',
): Promise<T> {
	let lastErr: unknown;
	for (let i = 1; i <= attempts; i++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (i < attempts) {
				const delay = Math.min(15000, 1000 * 2 ** Math.min(i - 1, 4)) + Math.floor(Math.random() * 500);
				if (i === 1 || i % 5 === 0) {
					const msg = err instanceof Error ? err.message : String(err);
					console.warn(`${label} failed (attempt ${i}/${attempts}), retrying in ${delay}ms: ${msg}`);
				}
				await sleep(delay);
			}
		}
	}
	throw lastErr;
}

interface MediaWikiQueryData {
	continue?: MwApiParams;
	parse?: { text?: string };
	query?: {
		pages?: unknown;
		backlinks?: Array<{ title?: string }>;
		embeddedin?: Array<{ title?: string }>;
		allpages?: Array<{ title?: string; ns?: number }>;
		categorymembers?: Array<{ title?: string; ns?: number; pageid?: number }>;
		allredirects?: Array<{ fromid?: number; title?: string }>;
		logevents?: Array<{ logid?: number; title?: string; comment?: string; suppressed?: boolean; pageid?: number }>;
		usercontribs?: Array<{ user: string; title: string; timestamp: string; ns?: number }>;
		abuselog?: Array<{ id: number; hidden?: boolean }>;
		recentchanges?: Array<{ title?: string }>;
	};
}

type PostWithTokenOptions = Parameters<MediaWikiApi['postWithToken']>[2];

/**
 * Execute a token-authenticated MediaWiki write action without aborting sibling tasks.
 * Logs the response JSON, checks `edit.result` when applicable, and sets `process.exitCode = 1`
 * on any exception or non-Success edit result so remaining items still run before exiting.
 */
async function safePostWithToken<T = unknown>(
	api: MediaWikiApi,
	tokenType: MwTokenName,
	params: MwApiParams,
	options: PostWithTokenOptions = { retry: 50, noCache: true },
) {
	const target = params.title ?? (params.pageid !== undefined ? `pageid=${String(params.pageid)}` : params.user ?? '');
	const label = `${String(params.action || tokenType)}${target ? `(${String(target)})` : ''}`;
	try {
		const res = await api.postWithToken<T>(tokenType, params, options);
		const { data } = res;
		console.log(JSON.stringify(data));
		const editResult = (data as { edit?: { result?: string } } | undefined)?.edit?.result;
		if (params.action === 'edit' && editResult && editResult !== 'Success') {
			console.error(`${label} 编辑未成功:`, JSON.stringify(data));
			process.exitCode = 1;
		}
		return res;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.error(`${label} 执行失败:`, msg);
		process.exitCode = 1;
		return undefined;
	}
}

export type { MediaWikiQueryData };
export {
	withRetry,
	safePostWithToken,
};
