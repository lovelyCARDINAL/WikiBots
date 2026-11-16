import { postWithRetry } from './retry.js';

/**
 * Paginate through a MediaWiki API query while preserving all `data.continue` tokens,
 * with high-count exponential backoff on transient transport/gateway errors.
 *
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {Record<string, unknown>} params
 * @param {Record<string, unknown>} [options]
 * @returns {AsyncGenerator<any>}
 */
async function* paginate(api, params, options = { retry: 25 }) {
	let cont = {};
	while (cont) {
		const { data } = await postWithRetry(api, {
			...params,
			...cont,
		}, options, 25);
		yield data;
		cont = data?.continue ?? null;
	}
}

export default paginate;
