import process from 'process';
import type { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import {
	extractAnchors,
	findBrokenAnchorLinks,
	loadFixAnchorConfig,
	normalizeAnchor,
	parseBrokenAnchorLine,
	rewriteAnchorLinks,
	updateBrokenAnchorsTalkPage,
} from '../utils/anchor/index.ts';
import {
	computePageAnchorState,
	fetchPageContent,
	getBacklinks,
	getTargetTitleSet,
	saveOrDeleteTalkPage,
	type PageAnchorState,
} from '../utils/anchor/wiki.ts';
import mapLimit from '../utils/common/concurrency.ts';
import { editTimeData, getTimeData } from '../utils/common/lastTime.ts';
import logger, { c } from '../utils/common/logger.ts';
import { createAndLogin } from '../utils/core/createApi.ts';
import paginate from '../utils/core/paginate.ts';

Parser.config = 'moegirl';

const TIME_KEY = 'fix-anchor';
const MAX_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const TARGET_NAMESPACES = '0|4|10|12|14';
const NOBOTS_REGEX = /\{\{(?:[Nn]obots|[Bb]ots\|(?:allow=none|deny=[^}]*(?:星海-adminbot|all)))\}\}/;

function pageHasLinkTo(content: string, targetTitle: string, targetAnchor: string, pageTitle?: string): boolean {
	const root = Parser.parse(content);
	const normTarget = Parser.normalizeTitle(targetTitle).title;
	const normPage = pageTitle ? Parser.normalizeTitle(pageTitle).title : '';
	const normAnchor = normalizeAnchor(targetAnchor);
	return root.querySelectorAll('link').some((link) => {
		if (!link.fragment || normalizeAnchor(link.fragment) !== normAnchor) {
			return false;
		}
		const isSelfSection = !link.name && Boolean(normPage) && normPage === normTarget;
		return isSelfSection || Boolean(link.name) && Parser.normalizeTitle(link.name).title === normTarget;
	});
}

interface ProcessCandidateOptions {
	api: MediaWikiApi;
	pageTitle: string;
	targetTitle: string;
	normalizedTarget: string;
	targetTitles: Set<string>;
	state: PageAnchorState;
}

async function processCandidatePage({
	api,
	pageTitle,
	targetTitle,
	normalizedTarget,
	targetTitles,
	state: { renameMap, brokenAnchors, finalAnchors },
}: ProcessCandidateOptions): Promise<void> {
	const content = await fetchPageContent(api, pageTitle);
	if (!content || NOBOTS_REGEX.test(content.replace(/\s+/g, ''))) {
		return;
	}

	const isSelf = Parser.normalizeTitle(pageTitle).title === normalizedTarget;
	const result = rewriteAnchorLinks(content, targetTitles, renameMap, isSelf);
	const latestContent = result.changed ? result.content : content;

	if (result.changed) {
		await api.postWithToken('csrf', {
			action: 'edit',
			title: pageTitle,
			text: latestContent,
			summary: `修复指向[[${targetTitle}]]的失效章节锚点（${result.replacements.length}处）`,
			bot: true,
			minor: true,
			nocreate: true,
			tags: 'Bot',
			watchlist: 'nochange',
		}, { retry: 25, noCache: true }).then(({ data: editRes }) => console.log(JSON.stringify(editRes)));
	}

	const remainingBroken = findBrokenAnchorLinks(latestContent, targetTitles, brokenAnchors, isSelf);
	const parsedPageTitle = Parser.normalizeTitle(pageTitle);
	if (parsedPageTitle.isTalkPage() || !remainingBroken.length && !result.changed) {
		return;
	}

	const talkTitle = parsedPageTitle.toTalkPage().title;
	const talkContent = await fetchPageContent(api, talkTitle) ?? '';
	if (!talkContent && !remainingBroken.length) {
		return;
	}

	const talkResult = updateBrokenAnchorsTalkPage(talkContent, {
		addLinks: remainingBroken,
		removeTemplate: 'Template:即将删除',
		subjectTitle: pageTitle,
		isStillBroken: (linkTitle, linkAnchor) => !targetTitles.has(linkTitle)
			|| !finalAnchors.has(linkAnchor) && pageHasLinkTo(latestContent, linkTitle, linkAnchor, pageTitle),
	});
	if (talkResult.changed) {
		await saveOrDeleteTalkPage(api, talkTitle, talkResult, false);
	}
}

async function processTargetPage(
	api: MediaWikiApi,
	targetTitle: string,
	state: PageAnchorState,
): Promise<void> {
	const targetTitles = await getTargetTitleSet(api, targetTitle);
	const backlinks = await getBacklinks(api, targetTitles, TARGET_NAMESPACES);
	const candidates = Array.from(new Set([targetTitle, ...backlinks]));
	if (!candidates.length) {
		return;
	}

	const normalizedTarget = Parser.normalizeTitle(targetTitle).title;
	await mapLimit(candidates, 5, (pageTitle) => processCandidatePage({
		api,
		pageTitle,
		targetTitle,
		normalizedTarget,
		targetTitles,
		state,
	}));
}

async function sweepTalkPage(
	api: MediaWikiApi,
	talkTitle: string,
	anchorCache: Map<string, Set<string>>,
	getTargetAnchors: (targetTitle: string) => Promise<Set<string>>,
): Promise<void> {
	const subjectTitle = Parser.normalizeTitle(talkTitle).toSubjectPage().title;
	const [talkContent, subjectContent] = await Promise.all([
		fetchPageContent(api, talkTitle),
		fetchPageContent(api, subjectTitle),
	]);
	if (!talkContent || !subjectContent) {
		return;
	}

	const tpl = Parser.parse(talkContent).querySelectorAll('template').find((t) => /^Template:Broken[ _]anchors$/i.test(t.name));
	if (!tpl) {
		return;
	}

	const targetTitlesToFetch = new Set<string>();
	for (const line of (tpl.getValue('links') || '').split(/\r?\n/)) {
		const parsed = parseBrokenAnchorLine(line, subjectTitle);
		if (parsed) {
			targetTitlesToFetch.add(parsed.title);
		}
	}
	for (const t of targetTitlesToFetch) {
		await getTargetAnchors(t);
	}

	const talkResult = updateBrokenAnchorsTalkPage(talkContent, {
		addLinks: [],
		subjectTitle,
		isStillBroken: (linkTitle, linkAnchor) => pageHasLinkTo(subjectContent, linkTitle, linkAnchor, subjectTitle)
			&& !anchorCache.get(linkTitle)?.has(linkAnchor),
	});
	if (talkResult.changed) {
		await saveOrDeleteTalkPage(api, talkTitle, talkResult, true);
	}
}

async function cleanupResolvedBrokenAnchors(api: MediaWikiApi): Promise<void> {
	const talkPages: string[] = [];
	for await (const data of paginate(api, { list: 'embeddedin', eititle: 'Template:Broken anchors', eilimit: 'max' })) {
		for (const item of data?.query?.embeddedin || []) {
			if (item.title && Parser.normalizeTitle(item.title).isTalkPage()) {
				talkPages.push(item.title);
			}
		}
	}
	if (!talkPages.length) {
		return;
	}

	const anchorCache = new Map<string, Set<string>>();
	const getTargetAnchors = async (targetTitle: string): Promise<Set<string>> => {
		const norm = Parser.normalizeTitle(targetTitle).title;
		if (anchorCache.has(norm)) {
			return anchorCache.get(norm)!;
		}
		const content = await fetchPageContent(api, norm, true);
		const anchors = content ? extractAnchors(content).all : new Set<string>();
		anchorCache.set(norm, anchors);
		return anchors;
	};

	await mapLimit(talkPages, 3, (talkTitle) => sweepTalkPage(api, talkTitle, anchorCache, getTargetAnchors));
}

(async () => {
	logger.start('fix-anchor');

	const api = await createAndLogin('zh', 'abot');
	const botConfig = await loadFixAnchorConfig(api);
	const ignoredPages = new Set(botConfig.ignorePages.map((t) => Parser.normalizeTitle(t).title));

	const timeData = await getTimeData();
	const nowMs = Date.now();
	const minSinceMs = nowMs - MAX_LOOKBACK_MS;
	const lastMs = timeData[TIME_KEY] ? Date.parse(timeData[TIME_KEY]) : NaN;
	const sinceIso = new Date(Number.isFinite(lastMs) ? Math.max(lastMs, minSinceMs) : minSinceMs).toISOString();
	const nowIso = new Date(nowMs - 2 * 60 * 1000).toISOString();

	const seen = new Set();
	const targetPages: string[] = [];
	for await (const data of paginate(api, {
		list: 'recentchanges',
		rctype: 'edit',
		rcnamespace: TARGET_NAMESPACES,
		rcshow: '!bot',
		rcprop: 'title|timestamp',
		rcstart: nowIso,
		rcend: sinceIso,
		rclimit: 'max',
	})) {
		for (const rc of data?.query?.recentchanges || []) {
			if (rc.title && !seen.has(rc.title) && !ignoredPages.has(Parser.normalizeTitle(rc.title).title)) {
				seen.add(rc.title);
				targetPages.push(rc.title);
			}
		}
	}

	logger.step(`Checking ${c.num(targetPages.length)} page(s) since ${c.cyan(sinceIso)}...`);

	await mapLimit(targetPages, 3, async (targetTitle) => {
		try {
			const state = await computePageAnchorState(api, targetTitle, sinceIso);
			if (!state.renameMap.size && !state.brokenAnchors.size) {
				return;
			}
			logger.info(`Detected anchor changes on ${c.page(targetTitle)}:`, {
				renames: Object.fromEntries(state.renameMap),
				removed: Object.fromEntries(state.brokenAnchors),
			});
			await processTargetPage(api, targetTitle, state);
		} catch (err) {
			logger.error(`Error processing ${c.page(targetTitle)}:`, err instanceof Error ? err.message : String(err));
			process.exitCode = 1;
		}
	});

	logger.step('Sweeping {{Broken anchors}}...');
	await cleanupResolvedBrokenAnchors(api);

	logger.step(`Updating data/time.yaml (${c.yellowBright(TIME_KEY)} = ${c.greenBright(nowIso)})...`);
	await editTimeData(timeData, TIME_KEY, nowIso);

	logger.end('fix-anchor');
})().catch((err) => {
	logger.error('Unhandled error in fix-anchor', err);
	process.exit(1);
});
