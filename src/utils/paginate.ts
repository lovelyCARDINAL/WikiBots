import type { FexiosFinalContext, MediaWikiApi, MwApiParams, MwApiResponse } from 'wiki-saikou';
import { withRetry, type MediaWikiQueryData } from './retry.ts';

/**
 * Paginate through a MediaWiki API query while preserving all `data.continue` tokens,
 * with high-count exponential backoff on transient transport/gateway errors.
 */
async function* paginate<T = MediaWikiQueryData>(
	api: MediaWikiApi,
	params: MwApiParams,
	options: Parameters<MediaWikiApi['post']>[1] = { retry: 25 },
): AsyncGenerator<MwApiResponse<T>> {
	let cont: MwApiParams | null = {};
	while (cont) {
		const currentCont = cont;
		const res: FexiosFinalContext<MwApiResponse<T>> = await withRetry(
			() => api.post<T>({ ...params, ...currentCont }, options),
			25,
			`api.post(${String(params.action || params.prop || params.list || 'query')})`,
		);
		yield res.data;
		cont = res.data?.continue ?? null;
	}
}

export default paginate;
