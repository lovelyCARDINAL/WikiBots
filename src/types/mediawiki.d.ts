export interface MwRevision {
	user?: string;
	timestamp?: string;
	content?: string;
	parentid?: number;
}

export interface MwRedirectItem {
	from: string;
	to: string;
}

export interface MwLinkItem {
	ns: number;
	title: string;
}

export interface MwAllUser {
	userid?: number;
	name: string;
	blockexpiry?: string;
	blockedtimestamp?: string;
}

export interface MwQueryResponse<T> {
	query: T;
}

export type MwPageContentResponse = MwQueryResponse<{
	pages: Array<{ revisions: Array<{ content: string }> }>;
}>;

export interface MwParseResponse<T = {
	wikitext?: string;
	text?: string;
	links?: MwLinkItem[];
}> {
	parse: T;
}
