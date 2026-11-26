import type { MediaWikiApi, MwApiParams } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import paginate from '../core/paginate.ts';
import { buildRenameMap, detectSectionChanges, extractAnchors } from './index.ts';

/**
 * Fetch normalized title set (page itself + redirects pointing to it).
 */
export async function getTargetTitleSet(api: MediaWikiApi, title: string): Promise<Set<string>> {
	const titles = new Set([Parser.normalizeTitle(title).title]);
	for await (const data of paginate(api, {
		prop: 'redirects',
		titles: title,
		rdlimit: 'max',
	})) {
		const pages = Object.values((data?.query?.pages || {}) as Record<string, { redirects?: Array<{ title?: string }> }>);
		for (const page of pages) {
			for (const rd of page.redirects || []) {
				if (rd.title) {
					titles.add(Parser.normalizeTitle(rd.title).title);
				}
			}
		}
	}
	return titles;
}

export async function fetchPageContent(api: MediaWikiApi, title: string, redirects = false): Promise<string | undefined> {
	const { data } = await api.post<{
		query?: { pages?: Record<string, { revisions?: Array<{ content?: string }> }> };
	}>({
		prop: 'revisions',
		titles: title,
		rvprop: 'content',
		...redirects && { redirects: true },
	}, { retry: 15 });
	return Object.values(data?.query?.pages || {})[0]?.revisions?.[0]?.content;
}

export async function getBacklinks(api: MediaWikiApi, targetTitles: Set<string>, namespaces: string): Promise<string[]> {
	const backlinks = new Set<string>();
	for (const targetTitle of targetTitles) {
		for await (const data of paginate(api, {
			list: 'backlinks',
			bltitle: targetTitle,
			blnamespace: namespaces,
			blfilterredir: 'nonredirects',
			bllimit: 'max',
		})) {
			for (const item of data?.query?.backlinks || []) {
				if (item.title) {
					backlinks.add(item.title);
				}
			}
		}
	}
	return [...backlinks];
}

export interface PageAnchorState {
	renameMap: Map<string, string>;
	brokenAnchors: Map<string, number | undefined>;
	finalAnchors: Set<string>;
}

export async function computePageAnchorState(
	api: MediaWikiApi,
	title: string,
	sinceIso: string,
): Promise<PageAnchorState> {
	const { data } = await api.post<{
		query?: { pages?: Record<string, { revisions?: Array<{ revid?: number; timestamp: string; content?: string }> }> };
	}>({
		prop: 'revisions',
		titles: title,
		rvprop: 'ids|timestamp|content',
		rvlimit: '15',
		rvdir: 'older',
	}, { retry: 15 });

	const page = Object.values(data?.query?.pages || {})[0];
	const revs = (page?.revisions || []).filter(
		(r): r is { revid?: number; timestamp: string; content: string } => typeof r.content === 'string',
	);
	if (revs.length < 2) {
		return { renameMap: new Map(), brokenAnchors: new Map(), finalAnchors: new Set() };
	}

	const chronological = [...revs].reverse();
	const sinceMs = Date.parse(sinceIso);
	const firstInWindowIdx = chronological.findIndex((r) => Date.parse(r.timestamp) >= sinceMs);
	const startIdx = firstInWindowIdx > 0 ? firstInWindowIdx - 1 : 0;
	const relevant = chronological.slice(startIdx);
	if (relevant.length < 2) {
		return { renameMap: new Map(), brokenAnchors: new Map(), finalAnchors: new Set() };
	}

	const anchorSnapshots = relevant.map((r) => extractAnchors(r.content));
	const stepRenames: Array<Map<string, string>> = [];
	const removedCandidates = new Map<string, number | undefined>();
	for (let i = 1; i < anchorSnapshots.length; i++) {
		const { renames, removed } = detectSectionChanges(anchorSnapshots[i - 1], anchorSnapshots[i]);
		if (renames.size) {
			stepRenames.push(renames);
		}
		for (const item of removed) {
			removedCandidates.set(item, relevant[i].revid);
		}
	}

	const finalAnchors = anchorSnapshots[anchorSnapshots.length - 1].all;
	const renameMap = buildRenameMap(stepRenames, finalAnchors);
	const brokenAnchors = new Map<string, number | undefined>();
	for (const [anchor, revid] of removedCandidates) {
		if (!finalAnchors.has(anchor) && !renameMap.has(anchor)) {
			brokenAnchors.set(anchor, revid);
		}
	}
	return { renameMap, brokenAnchors, finalAnchors };
}

export async function saveOrDeleteTalkPage(
	api: MediaWikiApi,
	talkTitle: string,
	talkResult: { content: string; addedCount: number; removedCount: number; templateRemoved: boolean },
	nocreate = false,
): Promise<void> {
	if (talkResult.templateRemoved && !talkResult.content.trim()) {
		await api.postWithToken('csrf', {
			action: 'delete',
			title: talkTitle,
			reason: '失效锚点已全部修复，移除{{Broken anchors}}后讨论页为空',
			tags: 'Bot',
			watchlist: 'nochange',
		}, { retry: 25, noCache: true }).then(({ data: delRes }) => console.log(JSON.stringify(delRes)));
		return;
	}

	const summary = talkResult.templateRemoved
		? '失效锚点已全部修复，移除{{Broken anchors}}提醒'
		: `更新{{Broken anchors}}提醒（新增${talkResult.addedCount}处，移除${talkResult.removedCount}处）`;

	const editParams: MwApiParams = {
		action: 'edit',
		title: talkTitle,
		text: talkResult.content,
		summary,
		bot: true,
		minor: true,
		tags: 'Bot',
		watchlist: 'nochange',
	};
	if (nocreate) {
		editParams.nocreate = true;
	}

	await api.postWithToken('csrf', editParams, { retry: 25, noCache: true })
		.then(({ data: editRes }) => console.log(JSON.stringify(editRes)));
}
