import type { FexiosFinalContext, MediaWikiApi, MwApiResponse } from 'wiki-saikou';

export interface EmbeddedPage {
	title: string;
	revisions: Array<{ content: string }>;
}

/**
 * Collect all mainspace pages embedding the given template with their wikitext content.
 */
export async function collectEmbeddedPages(api: MediaWikiApi, geititle: string): Promise<EmbeddedPage[]> {
	const result: EmbeddedPage[] = [];
	const eol = Symbol();
	let geicontinue: string | typeof eol | undefined = undefined;
	while (geicontinue !== eol) {
		const res: FexiosFinalContext<MwApiResponse<{
			query: { pages: Record<string, EmbeddedPage> };
		}>> = await api.post<{
			query: { pages: Record<string, EmbeddedPage> };
		}>({
			prop: 'revisions',
			generator: 'embeddedin',
			rvprop: 'content',
			geititle,
			geinamespace: '0',
			geilimit: '500',
			geicontinue: typeof geicontinue === 'string' ? geicontinue : undefined,
		}, {
			retry: 15,
		});
		const { data } = res;
		geicontinue = data.continue ? data.continue.geicontinue : eol;
		result.push(...Object.values(data.query.pages).filter((page) => page.revisions));
	}
	return result;
}
