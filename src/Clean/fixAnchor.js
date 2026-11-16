import process from 'process';
import Parser from 'wikiparser-node';
import {
	normalizeAnchor,
	extractAnchors,
	detectSectionChanges,
	buildRenameMap,
	rewriteAnchorLinks,
	findBrokenAnchorLinks,
	updateBrokenAnchorsTalkPage,
	loadFixAnchorConfig,
} from '../utils/anchor.js';
import mapLimit from '../utils/concurrency.js';
import { createAndLogin } from '../utils/createApi.js';
import { getTimeData, editTimeData } from '../utils/lastTime.js';
import paginate from '../utils/paginate.js';

Parser.config = 'moegirl';

const TIME_KEY = 'fix-anchor';
const MAX_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const TARGET_NAMESPACES = '0|4|10|12|14';
const NOBOTS_REGEX = /\{\{(?:[Nn]obots|[Bb]ots\|(?:allow=none|deny=[^}]*(?:机娘星海酱|all)))\}\}/;

/**
 * Fetch target page's normalized title set (including redirects to it).
 *
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {string} title
 * @returns {Promise<Set<string>>}
 */
async function getTargetTitleSet(api, title) {
	const titles = new Set([Parser.normalizeTitle(title).title]);
	for await (const data of paginate(api, {
		prop: 'redirects',
		titles: title,
		rdlimit: 'max',
	})) {
		const pages = Object.values(data?.query?.pages || {});
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

/**
 * Fetch backlink page titles pointing to any of targetTitles.
 *
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {Set<string>} targetTitles
 * @returns {Promise<string[]>}
 */
async function getBacklinks(api, targetTitles) {
	const backlinks = new Set();
	for (const targetTitle of targetTitles) {
		for await (const data of paginate(api, {
			list: 'backlinks',
			bltitle: targetTitle,
			blnamespace: TARGET_NAMESPACES,
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

/**
 * Compute unambiguous section anchor rename map and unresolved removed anchors
 * from recent revisions of `title`.
 *
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {string} title
 * @param {string} sinceIso
 * @returns {Promise<{ renameMap: Map<string, string>, brokenAnchors: Set<string>, finalAnchors: Set<string> }>}
 */
async function computePageAnchorState(api, title, sinceIso) {
	const { data } = await api.post({
		prop: 'revisions',
		titles: title,
		rvprop: 'ids|timestamp|content',
		rvlimit: '15',
		rvdir: 'older',
	}, { retry: 15 });

	const page = Object.values(data?.query?.pages || {})[0];
	const revs = (page?.revisions || []).filter((r) => typeof r.content === 'string');
	if (revs.length < 2) {
		return { renameMap: new Map(), brokenAnchors: new Set(), finalAnchors: new Set() };
	}

	const chronological = [...revs].reverse();
	const sinceMs = Date.parse(sinceIso);
	const firstInWindowIdx = chronological.findIndex((r) => Date.parse(r.timestamp) >= sinceMs);
	const startIdx = firstInWindowIdx > 0 ? firstInWindowIdx - 1 : 0;
	const relevant = chronological.slice(startIdx);
	if (relevant.length < 2) {
		return { renameMap: new Map(), brokenAnchors: new Set(), finalAnchors: new Set() };
	}

	const anchorSnapshots = relevant.map((r) => extractAnchors(r.content));
	const stepRenames = [];
	const removedCandidates = new Set();
	for (let i = 1; i < anchorSnapshots.length; i++) {
		const { renames, removed } = detectSectionChanges(anchorSnapshots[i - 1], anchorSnapshots[i]);
		if (renames.size) {
			stepRenames.push(renames);
		}
		for (const item of removed) {
			removedCandidates.add(item);
		}
	}

	const finalAnchors = anchorSnapshots[anchorSnapshots.length - 1].all;
	const renameMap = buildRenameMap(stepRenames, finalAnchors);
	const brokenAnchors = new Set(
		[...removedCandidates].filter((a) => !finalAnchors.has(a) && !renameMap.has(a)),
	);
	return { renameMap, brokenAnchors, finalAnchors };
}

/**
 * Check if `content` still contains any link pointing to `targetTitle#targetAnchor`.
 *
 * @param {string} content
 * @param {string} targetTitle
 * @param {string} targetAnchor
 * @returns {boolean}
 */
function pageHasLinkTo(content, targetTitle, targetAnchor) {
	const root = Parser.parse(content);
	const normTarget = Parser.normalizeTitle(targetTitle).title;
	const normAnchor = normalizeAnchor(targetAnchor);
	return root.querySelectorAll('link').some((link) => {
		if (!link.name || !link.fragment) {
			return false;
		}
		return Parser.normalizeTitle(link.name).title === normTarget
			&& normalizeAnchor(link.fragment) === normAnchor;
	});
}

/**
 * Fix broken anchor links on candidate pages and manage `{{Broken anchors}}` on talk pages.
 *
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {string} targetTitle
 * @param {{ renameMap: Map<string, string>, brokenAnchors: Set<string>, finalAnchors: Set<string> }} state
 */
async function processTargetPage(api, targetTitle, { renameMap, brokenAnchors, finalAnchors }) {
	const targetTitles = await getTargetTitleSet(api, targetTitle);
	const backlinks = await getBacklinks(api, targetTitles);
	const candidates = Array.from(new Set([targetTitle, ...backlinks]));
	if (!candidates.length) {
		return;
	}

	const normalizedTarget = Parser.normalizeTitle(targetTitle).title;
	await mapLimit(candidates, 5, async (pageTitle) => {
		const { data } = await api.post({
			prop: 'revisions',
			titles: pageTitle,
			rvprop: 'content|timestamp',
		}, { retry: 15 });
		const page = Object.values(data?.query?.pages || {})[0];
		const content = page?.revisions?.[0]?.content;
		if (!content || NOBOTS_REGEX.test(content.replace(/\s+/g, ''))) {
			return;
		}

		const isSelf = Parser.normalizeTitle(pageTitle).title === normalizedTarget;
		const result = rewriteAnchorLinks(content, targetTitles, renameMap, isSelf);
		const latestContent = result.changed ? result.content : content;

		if (result.changed) {
			const summary = `机器人：修复指向[[${targetTitle}]]的失效章节锚点（${result.replacements.length}处）`;
			await api.postWithToken('csrf', {
				action: 'edit',
				title: pageTitle,
				text: latestContent,
				summary,
				bot: true,
				minor: true,
				nocreate: true,
				tags: 'Bot',
				watchlist: 'nochange',
			}, {
				retry: 25,
				noCache: true,
			}).then(({ data: editRes }) => console.log(JSON.stringify(editRes)));
		}

		const remainingBroken = findBrokenAnchorLinks(latestContent, targetTitles, brokenAnchors, isSelf);
		const parsedPageTitle = Parser.normalizeTitle(pageTitle);
		if (parsedPageTitle.isTalkPage() || !remainingBroken.length && !result.changed) {
			return;
		}

		const talkTitle = parsedPageTitle.toTalkPage().title;
		const { data: talkData } = await api.post({
			prop: 'revisions',
			titles: talkTitle,
			rvprop: 'content',
		}, { retry: 15 });
		const talkPage = Object.values(talkData?.query?.pages || {})[0];
		const talkContent = talkPage?.revisions?.[0]?.content || '';
		if (!talkContent && !remainingBroken.length) {
			return;
		}

		const talkResult = updateBrokenAnchorsTalkPage(talkContent, {
			addLinks: remainingBroken,
			isStillBroken: (linkTitle, linkAnchor) => {
				if (!targetTitles.has(linkTitle)) {
					return true;
				}
				return !finalAnchors.has(linkAnchor) && pageHasLinkTo(latestContent, linkTitle, linkAnchor);
			},
		});
		if (!talkResult.changed) {
			return;
		}

		const talkSummary = talkResult.templateRemoved
			? '机器人：失效锚点已全部修复，移除{{Broken anchors}}提醒'
			: `机器人：更新{{Broken anchors}}提醒（新增${talkResult.addedCount}处，移除${talkResult.removedCount}处）`;

		await api.postWithToken('csrf', {
			action: 'edit',
			title: talkTitle,
			text: talkResult.content,
			summary: talkSummary,
			bot: true,
			minor: true,
			tags: 'Bot',
			watchlist: 'nochange',
		}, {
			retry: 25,
			noCache: true,
		}).then(({ data: editRes }) => console.log(JSON.stringify(editRes)));
	});
}

/**
 * Sweep talk pages currently transcluding `Template:Broken anchors` and prune/remove
 * entries whose links no longer exist on the subject page or whose target anchors now exist.
 *
 * @param {import('wiki-saikou').MediaWikiApi} api
 */
async function cleanupResolvedBrokenAnchors(api) {
	const talkPages = [];
	for await (const data of paginate(api, {
		list: 'embeddedin',
		eititle: 'Template:Broken anchors',
		eilimit: 'max',
	})) {
		for (const item of data?.query?.embeddedin || []) {
			if (item.title && Parser.normalizeTitle(item.title).isTalkPage()) {
				talkPages.push(item.title);
			}
		}
	}

	if (!talkPages.length) {
		return;
	}

	const anchorCache = new Map();
	const getTargetAnchors = async (targetTitle) => {
		const norm = Parser.normalizeTitle(targetTitle).title;
		if (anchorCache.has(norm)) {
			return anchorCache.get(norm);
		}
		const { data } = await api.post({
			prop: 'revisions',
			titles: norm,
			rvprop: 'content',
			redirects: true,
		}, { retry: 15 });
		const page = Object.values(data?.query?.pages || {})[0];
		const content = page?.revisions?.[0]?.content;
		const anchors = content ? extractAnchors(content).all : new Set();
		anchorCache.set(norm, anchors);
		return anchors;
	};

	await mapLimit(talkPages, 3, async (talkTitle) => {
		const subjectTitle = Parser.normalizeTitle(talkTitle).toSubjectPage().title;

		const [{ data: talkData }, { data: subjectData }] = await Promise.all([
			api.post({ prop: 'revisions', titles: talkTitle, rvprop: 'content' }, { retry: 15 }),
			api.post({ prop: 'revisions', titles: subjectTitle, rvprop: 'content' }, { retry: 15 }),
		]);

		const talkContent = Object.values(talkData?.query?.pages || {})[0]?.revisions?.[0]?.content;
		const subjectContent = Object.values(subjectData?.query?.pages || {})[0]?.revisions?.[0]?.content;
		if (!talkContent || !subjectContent) {
			return;
		}

		const root = Parser.parse(talkContent);
		const tpl = root.querySelectorAll('template').find((t) => /^Template:Broken[ _]anchors$/i.test(t.name));
		if (!tpl) {
			return;
		}

		const rawLinks = tpl.getValue('links') || '';
		const targetTitlesToFetch = new Set();
		for (const line of rawLinks.split(/\r?\n/)) {
			const link = Parser.parse(line).querySelector('link');
			if (link?.name) {
				targetTitlesToFetch.add(Parser.normalizeTitle(link.name).title);
			}
		}
		for (const t of targetTitlesToFetch) {
			await getTargetAnchors(t);
		}

		const talkResult = updateBrokenAnchorsTalkPage(talkContent, {
			addLinks: [],
			isStillBroken: (linkTitle, linkAnchor) => {
				if (!pageHasLinkTo(subjectContent, linkTitle, linkAnchor)) {
					return false;
				}
				const targetAnchors = anchorCache.get(linkTitle);
				return !targetAnchors?.has(linkAnchor);
			},
		});
		if (!talkResult.changed) {
			return;
		}

		const talkSummary = talkResult.templateRemoved
			? '机器人：失效锚点已全部修复，移除{{Broken anchors}}提醒'
			: `机器人：清理已修复的{{Broken anchors}}提醒（移除${talkResult.removedCount}处）`;

		await api.postWithToken('csrf', {
			action: 'edit',
			title: talkTitle,
			text: talkResult.content,
			summary: talkSummary,
			bot: true,
			minor: true,
			nocreate: true,
			tags: 'Bot',
			watchlist: 'nochange',
		}, {
			retry: 25,
			noCache: true,
		}).then(({ data: editRes }) => console.log(JSON.stringify(editRes)));
	});
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	const api = await createAndLogin('zh', 'bot');
	const botConfig = await loadFixAnchorConfig(api);
	const ignoredPages = new Set(botConfig.ignorePages.map((t) => Parser.normalizeTitle(t).title));

	const timeData = await getTimeData();
	const nowMs = Date.now();
	const minSinceMs = nowMs - MAX_LOOKBACK_MS;
	const lastMs = timeData[TIME_KEY] ? Date.parse(timeData[TIME_KEY]) : NaN;
	const sinceIso = new Date(
		Number.isFinite(lastMs) ? Math.max(lastMs, minSinceMs) : minSinceMs,
	).toISOString();
	const nowIso = new Date(nowMs - 2 * 60 * 1000).toISOString();

	const seen = new Set();
	const targetPages = [];
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

	console.log(`Checking ${targetPages.length} page(s) since ${sinceIso}...`);

	await mapLimit(targetPages, 3, async (targetTitle) => {
		try {
			const state = await computePageAnchorState(api, targetTitle, sinceIso);
			if (!state.renameMap.size && !state.brokenAnchors.size) {
				return;
			}
			console.log(`Detected anchor changes on [[${targetTitle}]]:`, {
				renames: Object.fromEntries(state.renameMap),
				removed: [...state.brokenAnchors],
			});
			await processTargetPage(api, targetTitle, state);
		} catch (err) {
			console.error(`Error processing [[${targetTitle}]]:`, err?.message || err);
		}
	});

	console.log('Sweeping Template:Broken anchors...');
	await cleanupResolvedBrokenAnchors(api);

	console.log(`Updating data/time.yaml (${TIME_KEY} = ${nowIso})...`);
	await editTimeData(timeData, TIME_KEY, nowIso);

	console.log(`End time: ${new Date().toISOString()}`);
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
