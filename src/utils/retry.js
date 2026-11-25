import process from 'process';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Execute an async API call with jittered exponential backoff for transient
 * Moegirlpedia gateway/network errors (including `fetch failed` and
 * `Failed to transform response body to json`).
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number} [attempts=25]
 * @param {string} [label='API request']
 * @returns {Promise<T>}
 */
async function withRetry(fn, attempts = 25, label = 'API request') {
	let lastErr;
	for (let i = 1; i <= attempts; i++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (i < attempts) {
				const delay = Math.min(15000, 1000 * 2 ** Math.min(i - 1, 4)) + Math.floor(Math.random() * 500);
				if (i === 1 || i % 5 === 0) {
					console.warn(`${label} failed (attempt ${i}/${attempts}), retrying in ${delay}ms: ${err?.message || err}`);
				}
				await sleep(delay);
			}
		}
	}
	throw lastErr;
}

/**
 * Wrapper around `api.post` with high-count outer retries.
 *
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {Record<string, unknown>} params
 * @param {Record<string, unknown>} [options]
 * @param {number} [attempts=25]
 * @returns {Promise<any>}
 */
function postWithRetry(api, params, options = { retry: 25 }, attempts = 25) {
	return withRetry(() => api.post(params, options), attempts, `api.post(${params.action || params.prop || params.list || 'query'})`);
}

/**
 * Wrapper around `api.postWithToken` with high-count outer retries.
 *
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {string} tokenType
 * @param {Record<string, unknown>} params
 * @param {Record<string, unknown>} [options]
 * @param {number} [attempts=25]
 * @returns {Promise<any>}
 */
function postWithTokenRetry(api, tokenType, params, options = { retry: 25, noCache: true }, attempts = 25) {
	return withRetry(async () => {
		const res = await api.postWithToken(tokenType, params, options);
		if (params.action === 'edit' && res?.data?.edit?.result && res.data.edit.result !== 'Success') {
			throw new Error(`Edit failed: ${JSON.stringify(res.data)}`);
		}
		return res;
	}, attempts, `api.postWithToken(${params.action || tokenType})`);
}

/**
 * Execute a token-authenticated MediaWiki write action without aborting sibling tasks.
 * Logs the response JSON, checks `edit.result` when applicable, and sets `process.exitCode = 1`
 * on any exception or non-Success edit result so remaining items still run before exiting.
 *
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {string} tokenType
 * @param {Record<string, unknown>} params
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<any>}
 */
async function safePostWithToken(api, tokenType, params, options = { retry: 50, noCache: true }) {
	const target = params.title ?? (params.pageid !== undefined ? `pageid=${params.pageid}` : params.user ?? '');
	const label = `${params.action || tokenType}${target ? `(${target})` : ''}`;
	try {
		const res = await api.postWithToken(tokenType, params, options);
		const { data } = res;
		console.log(JSON.stringify(data));
		if (params.action === 'edit' && data?.edit?.result && data.edit.result !== 'Success') {
			console.error(`${label} 编辑未成功:`, JSON.stringify(data));
			process.exitCode = 1;
		}
		return res;
	} catch (error) {
		console.error(`${label} 执行失败:`, error?.message || error);
		process.exitCode = 1;
		return undefined;
	}
}

export {
	withRetry,
	postWithRetry,
	postWithTokenRetry,
	safePostWithToken,
};
