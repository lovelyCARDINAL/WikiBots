const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Paginate through a MediaWiki API query while preserving all `data.continue` tokens,
 * with exponential backoff on transient transport errors.
 *
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {Record<string, unknown>} params
 * @param {Record<string, unknown>} [options]
 * @returns {AsyncGenerator<any>}
 */
async function* paginate(api, params, options = { retry: 15 }) {
	let cont = {};
	while (cont) {
		let res;
		let lastErr;
		for (let attempt = 1; attempt <= 4; attempt++) {
			try {
				res = await api.post({
					...params,
					...cont,
				}, options);
				break;
			} catch (err) {
				lastErr = err;
				if (attempt < 4) {
					await sleep(1000 * 2 ** (attempt - 1));
				}
			}
		}
		if (!res) {
			throw lastErr;
		}
		const { data } = res;
		yield data;
		cont = data?.continue ?? null;
	}
}

export default paginate;
