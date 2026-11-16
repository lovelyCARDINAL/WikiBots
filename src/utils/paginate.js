/**
 * Paginate through a MediaWiki API query while preserving all `data.continue` tokens.
 *
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {Record<string, unknown>} params
 * @param {Record<string, unknown>} [options]
 * @returns {AsyncGenerator<any>}
 */
async function* paginate(api, params, options = { retry: 15 }) {
	let cont = {};
	while (cont) {
		const { data } = await api.post({
			...params,
			...cont,
		}, options);
		yield data;
		cont = data.continue ?? null;
	}
}

export default paginate;
