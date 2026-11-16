import { env, argv } from 'process';
import Parser from 'wikiparser-node';
import {
	normalizeAnchor,
	extractAnchors,
	detectSectionChanges,
	buildRenameMap,
	rewriteAnchorLinks,
	findBrokenAnchorLinks,
	updateBrokenAnchorsTalkPage,
} from '../utils/anchor.js';
import mapLimit from '../utils/concurrency.js';
import config from '../utils/config.js';
import { createApi, createAndLogin } from '../utils/createApi.js';
import { getTimeData, editTimeData } from '../utils/lastTime.js';
import paginate from '../utils/paginate.js';

Parser.config = 'moegirl';

const TIME_KEY = 'fix-anchor';
const TARGET_NAMESPACES = '0|4|10|12|14';
const NOBOTS_REGEX = /\{\{(?:[Nn]obots|[Bb]ots\|(?:allow=none|deny=[^}]*(?:机娘星海酱|all)))\}\}/;

/**
 * Parse CLI arguments (`--dry-run`, `--self-test`, `--check-page=...`, `--only-modify-pages=...`, `--limit=...`).
 *
 * @returns {{ dryRun: boolean, selfTest: boolean, checkPage: string | null, onlyModifyPages: Set<string> | null, limit: number }}
 */
function parseArgs() {
	const dryRun = argv.includes('--dry-run') || ['1', 'true'].includes(String(env.DRY_RUN).toLowerCase());
	const selfTest = argv.includes('--self-test') || ['1', 'true'].includes(String(env.SELF_TEST).toLowerCase());
	const getOpt = (prefix) => {
		const found = argv.find((a) => a.startsWith(prefix));
		return found ? found.slice(prefix.length) : null;
	};
	const checkPage = getOpt('--check-page=');
	const onlyRaw = getOpt('--only-modify-pages=');
	const onlyModifyPages = onlyRaw
		? new Set(onlyRaw.split('|').map((t) => Parser.normalizeTitle(t.trim()).title).filter(Boolean))
		: null;
	const limitRaw = Number.parseInt(getOpt('--limit=') || '100', 10);
	const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100;
	return { dryRun, selfTest, checkPage, onlyModifyPages, limit };
}

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
 * @param {{ dryRun: boolean, onlyModifyPages: Set<string> | null }} opts
 */
async function processTargetPage(api, targetTitle, { renameMap, brokenAnchors, finalAnchors }, { dryRun, onlyModifyPages }) {
	const targetTitles = await getTargetTitleSet(api, targetTitle);
	const backlinks = await getBacklinks(api, targetTitles);
	const candidates = Array.from(new Set([targetTitle, ...backlinks]));
	const filtered = onlyModifyPages
		? candidates.filter((t) => onlyModifyPages.has(Parser.normalizeTitle(t).title))
		: candidates;

	if (!filtered.length) {
		return;
	}

	const normalizedTarget = Parser.normalizeTitle(targetTitle).title;
	await mapLimit(filtered, 5, async (pageTitle) => {
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
			if (dryRun) {
				console.log(`[DRY-RUN] Would edit [[${pageTitle}]] (${summary}):`);
				for (const r of result.replacements) {
					console.log(`  - ${r.from} => ${r.to}`);
				}
			} else {
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
		if (dryRun) {
			console.log(`[DRY-RUN] Would update talk page [[${talkTitle}]] (${talkSummary}):`);
			console.log(talkResult.content);
			return;
		}

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
 * @param {{ dryRun: boolean, onlyModifyPages: Set<string> | null }} opts
 */
async function cleanupResolvedBrokenAnchors(api, { dryRun, onlyModifyPages }) {
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
		if (onlyModifyPages && !onlyModifyPages.has(subjectTitle)) {
			return;
		}

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
		if (dryRun) {
			console.log(`[DRY-RUN] Would clean talk page [[${talkTitle}]] (${talkSummary}):`);
			console.log(talkResult.content);
			return;
		}

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

/**
 * Run deterministic in-memory self-tests for all 3 core behaviors:
 * 1) Auto-fixing 1-to-1 renamed section anchors
 * 2) Adding {{Broken anchors}} notice on talk page for unfixable/removed anchors
 * 3) Auto-pruning & removing {{Broken anchors}} once fixed
 */
function runSelfTest() {
	console.log('=== Running fixAnchor self-test ===');
	const rev1 = '== 简介 ==\n== 外部链接 ==\n== 已删除章节 ==\n';
	const rev2 = '== 简介 ==\n== 注释和外部链接 ==\n== 已删除章节 ==\n';
	const rev3 = '== 简介 ==\n== 注释和外部链接 ==\n';

	const step1 = detectSectionChanges(extractAnchors(rev1), extractAnchors(rev2));
	const step2 = detectSectionChanges(extractAnchors(rev2), extractAnchors(rev3));
	const finalAnchors = extractAnchors(rev3).all;
	const renameMap = buildRenameMap([step1.renames, step2.renames], finalAnchors);
	const brokenSet = new Set(step2.removed.filter((a) => !finalAnchors.has(a) && !renameMap.has(a)));
	console.log('1) Detected changes:', { renames: Object.fromEntries(renameMap), removed: [...brokenSet] });

	const targetTitles = new Set(['测试条目']);
	const linkingPage = '参考[[测试条目#外部链接|外部链接]]，以及[[测试条目#已删除章节]]。';
	const rewriteRes = rewriteAnchorLinks(linkingPage, targetTitles, renameMap, false);
	console.log('2) Auto-fixed linking page:', rewriteRes.replacements, '=>', rewriteRes.content);

	const remainingBroken = findBrokenAnchorLinks(rewriteRes.content, targetTitles, brokenSet, false);
	const talkStep1 = updateBrokenAnchorsTalkPage('现有讨论内容。\n', {
		addLinks: remainingBroken,
		isStillBroken: () => true,
	});
	console.log(`3) Talk page after adding {{Broken anchors}}:\n${talkStep1.content}`);

	const fixedLinkingPage = rewriteRes.content.replace('[[测试条目#已删除章节]]', '[[测试条目#简介]]');
	const talkStep2 = updateBrokenAnchorsTalkPage(talkStep1.content, {
		addLinks: [],
		isStillBroken: (t, a) => pageHasLinkTo(fixedLinkingPage, t, a),
	});
	console.log(`4) Talk page after broken link fixed (templateRemoved=${talkStep2.templateRemoved}):\n${talkStep2.content}`);

	if (
		rewriteRes.content !== '参考[[测试条目#注释和外部链接|外部链接]]，以及[[测试条目#已删除章节]]。'
		|| !talkStep1.content.includes('{{Broken anchors')
		|| !talkStep1.content.includes('* [[测试条目#已删除章节]]')
		|| !talkStep2.templateRemoved
		|| talkStep2.content.trim() !== '现有讨论内容。'
	) {
		throw new Error('Self-test assertion failed!');
	}
	console.log('=== Self-test PASSED ===');
}

(async () => {
	const { dryRun, selfTest, checkPage, onlyModifyPages, limit } = parseArgs();
	if (selfTest) {
		runSelfTest();
		return;
	}
	console.log(`Start time: ${new Date().toISOString()} (dryRun=${dryRun})`);

	const api = dryRun && !config.zh.bot.password
		? createApi('zh')
		: await createAndLogin('zh', 'bot');

	const timeData = checkPage ? null : await getTimeData();
	const sinceIso = timeData?.[TIME_KEY] || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	const nowIso = new Date(Date.now() - 2 * 60 * 1000).toISOString();

	let targetPages = [];
	if (checkPage) {
		targetPages = [checkPage];
	} else {
		const seen = new Set();
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
				if (rc.title && !seen.has(rc.title)) {
					seen.add(rc.title);
					targetPages.push(rc.title);
					if (targetPages.length >= limit) {
						break;
					}
				}
			}
			if (targetPages.length >= limit) {
				break;
			}
		}
	}

	console.log(`Checking ${targetPages.length} page(s) since ${sinceIso}...`);

	await mapLimit(targetPages, 3, async (targetTitle) => {
		const state = await computePageAnchorState(api, targetTitle, sinceIso);
		if (!state.renameMap.size && !state.brokenAnchors.size) {
			return;
		}
		console.log(`Detected anchor changes on [[${targetTitle}]]:`, {
			renames: Object.fromEntries(state.renameMap),
			removed: [...state.brokenAnchors],
		});
		await processTargetPage(api, targetTitle, state, { dryRun, onlyModifyPages });
	});

	if (!checkPage) {
		await cleanupResolvedBrokenAnchors(api, { dryRun, onlyModifyPages });
	}

	if (!dryRun && !checkPage && timeData) {
		await editTimeData(timeData, TIME_KEY, nowIso);
	}

	console.log(`End time: ${new Date().toISOString()}`);
})();
