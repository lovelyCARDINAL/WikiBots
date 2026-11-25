import type { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import mapLimit from '../common/concurrency.ts';
import splitAndJoin from '../common/splitAndJoin.ts';
import paginate from '../core/paginate.ts';
import { withRetry } from '../core/retry.ts';
import {
	getGroupNameFromTitle,
	extractVocabularies,
	parseLuaCGroup,
	parseWikitextCGroup,
	parseSystemConversionTable,
} from './index.ts';

export { buildConversionAliases } from './aliases.ts';

export interface ConversionPageMeta {
	title: string;
	ns: number;
}

export interface ConversionEntry {
	rules: string[];
	vocabularies: string[];
	transclusions: string[];
	redirectTo: string | null;
	error?: string | null;
}

export interface RawGroupEntry {
	rules: string[];
	transclusions: string[];
	redirectTo: string | null;
	pageTitle: string;
}

export interface QueryPage {
	title?: string;
	ns?: number;
	missing?: boolean;
	touched?: string;
	revisions?: Array<{ content?: string }>;
}

function enqueueCategoryMember(
	item: { title?: string; ns?: number },
	isDep: boolean,
	queue: Array<{ title: string; deprecated: boolean }>,
	active: Array<{ title: string; ns: number }>,
	deprecated: Set<string>,
): void {
	if (!item.title) {
		return;
	}
	if (item.ns === 14) {
		queue.push({ title: item.title, deprecated: isDep || item.title.includes('已停用') });
		return;
	}
	if (item.ns !== 10 && item.ns !== 828) {
		return;
	}
	if (isDep) {
		deprecated.add(item.title);
	} else {
		active.push({ title: item.title, ns: item.ns });
	}
}

/**
 * Traverse a category tree recursively to collect Module (828) and Template (10) pages,
 * tracking deprecated pages from subcategories whose title includes `已停用`.
 */
export async function collectCategoryTree(
	api: MediaWikiApi,
	rootCategory: string,
): Promise<{ active: Array<{ title: string; ns: number }>; deprecated: Set<string> }> {
	const visitedCats = new Set<string>();
	const queue: Array<{ title: string; deprecated: boolean }> = [{ title: rootCategory, deprecated: false }];
	const active: Array<{ title: string; ns: number }> = [];
	const deprecated = new Set<string>();

	while (queue.length) {
		const { title: catTitle, deprecated: isDep } = queue.shift()!;
		if (visitedCats.has(catTitle)) {
			continue;
		}
		visitedCats.add(catTitle);

		for await (const data of paginate(api, {
			list: 'categorymembers',
			cmtitle: catTitle,
			cmtype: 'page|subcat',
			cmnamespace: '10|14|828',
			cmlimit: 'max',
		})) {
			for (const item of data?.query?.categorymembers || []) {
				enqueueCategoryMember(item, isDep, queue, active, deprecated);
			}
		}
	}

	return { active, deprecated };
}

/**
 * Fetch prefix pages matching `<nsPrefix>CGroup/`.
 */
export async function fetchCGroupPrefix(api: MediaWikiApi, ns: number): Promise<ConversionPageMeta[]> {
	const pages: ConversionPageMeta[] = [];
	for await (const data of paginate(api, {
		list: 'allpages',
		apprefix: 'CGroup/',
		apnamespace: String(ns),
		aplimit: 'max',
	})) {
		for (const item of data?.query?.allpages || []) {
			if (item.title && typeof item.ns === 'number' && /^(?:Module|Template):CGroup\/[^/]+$/i.test(item.title)) {
				pages.push({ title: item.title, ns: item.ns });
			}
		}
	}
	return pages;
}

/**
 * Fetch `MediaWiki:Conversiontable/*` (namespace 8) system conversion pages.
 */
export async function fetchSystemConversionPages(api: MediaWikiApi): Promise<ConversionPageMeta[]> {
	const pages: ConversionPageMeta[] = [];
	for await (const data of paginate(api, {
		list: 'allpages',
		apprefix: 'Conversiontable/',
		apnamespace: '8',
		aplimit: 'max',
	})) {
		for (const item of data?.query?.allpages || []) {
			if (item.title) {
				pages.push({ title: item.title, ns: 8 });
			}
		}
	}
	return pages;
}

function parseSingleConversionPage(
	page: QueryPage,
	pageMetaByTitle: Map<string, ConversionPageMeta>,
	conversionOfPage: Record<string, ConversionEntry>,
	rawGroupData: Record<string, RawGroupEntry>,
	vocabOwners: Map<string, Set<string>>,
): void {
	const { title } = page;
	if (!title) {
		return;
	}
	const meta = pageMetaByTitle.get(Parser.normalizeTitle(title).title) || { ns: page.ns ?? 0 };
	const content = page?.revisions?.[0]?.content;
	if (!content) {
		conversionOfPage[title] = { rules: [], vocabularies: [], transclusions: [], redirectTo: null, error: '无法读取页面内容' };
		return;
	}

	let rules: string[];
	let vocabularies: string[];
	let transclusions: string[];
	let redirectTo: string | null;
	if (meta.ns === 8) {
		({ rules, vocabularies, transclusions, redirectTo } = parseSystemConversionTable(content));
	} else {
		const parsed = meta.ns === 828 ? parseLuaCGroup(content) : parseWikitextCGroup(content);
		({ rules, transclusions, redirectTo } = parsed);
		vocabularies = extractVocabularies(rules);
	}
	conversionOfPage[title] = { rules, vocabularies, transclusions, redirectTo };
	if (meta.ns !== 8) {
		rawGroupData[getGroupNameFromTitle(title)] = { rules, transclusions, redirectTo, pageTitle: title };
	}

	for (const vocab of vocabularies) {
		const owners = vocabOwners.get(vocab) ?? new Set<string>();
		owners.add(title);
		vocabOwners.set(vocab, owners);
	}
}

export async function parseAllConversionPages(
	api: MediaWikiApi,
	allConversionPages: ConversionPageMeta[],
): Promise<{
	conversionOfPage: Record<string, ConversionEntry>;
	rawGroupData: Record<string, RawGroupEntry>;
	vocabOwners: Map<string, Set<string>>;
}> {
	const conversionOfPage = Object.create(null) as Record<string, ConversionEntry>;
	const rawGroupData = Object.create(null) as Record<string, RawGroupEntry>;
	const vocabOwners = new Map<string, Set<string>>();
	const pageMetaByTitle = new Map(allConversionPages.map((p) => [Parser.normalizeTitle(p.title).title, p]));

	const convTitleBatches = splitAndJoin(allConversionPages.map((p) => p.title), 50);
	await mapLimit(convTitleBatches, 2, async (titlesBatch) => {
		const { data } = await withRetry(() => api.post<{
			query?: { pages?: Record<string, QueryPage> };
		}>({
			prop: 'revisions',
			titles: titlesBatch,
			rvprop: 'content',
		}, { retry: 25 }), 25, 'api.post(revisions)');
		for (const page of Object.values(data?.query?.pages || {})) {
			parseSingleConversionPage(page, pageMetaByTitle, conversionOfPage, rawGroupData, vocabOwners);
		}
	});

	return { conversionOfPage, rawGroupData, vocabOwners };
}

function resolveGroupTarget(rawGroupData: Record<string, RawGroupEntry>, groupName: string): string {
	let curr = groupName;
	const seen = new Set<string>();
	for (let hop = 0; hop < 5 && rawGroupData[curr]?.redirectTo; hop++) {
		if (seen.has(curr)) {
			break;
		}
		seen.add(curr);
		curr = getGroupNameFromTitle(rawGroupData[curr].redirectTo!);
	}
	return curr;
}

export function resolveGroupRules(rawGroupData: Record<string, RawGroupEntry>): {
	groupRules: Record<string, string[]>;
	redirectAliases: Record<string, string>;
} {
	const groupRules = Object.create(null) as Record<string, string[]>;
	const redirectAliases = Object.create(null) as Record<string, string>;

	for (const groupName of Object.keys(rawGroupData)) {
		const canonical = resolveGroupTarget(rawGroupData, groupName);
		const info = rawGroupData[canonical] || rawGroupData[groupName];
		if (canonical !== groupName && canonical in rawGroupData) {
			redirectAliases[groupName] = canonical;
		}
		const merged = new Set(info.rules);
		for (const inc of info.transclusions) {
			const incCanonical = resolveGroupTarget(rawGroupData, inc);
			for (const r of rawGroupData[incCanonical]?.rules || []) {
				merged.add(r);
			}
		}
		groupRules[groupName] = [...merged];
	}

	return { groupRules, redirectAliases };
}
