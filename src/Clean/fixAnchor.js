import { env, argv } from 'process';
import Parser from 'wikiparser-node';
import {
	extractAnchors,
	detectSectionRenames,
	buildRenameMap,
	rewriteAnchorLinks,
} from '../utils/anchor.js';
import mapLimit from '../utils/concurrency.js';
import config from '../utils/config.js';
import { createApi, createAndLogin } from '../utils/createApi.js';
import { getTimeData, editTimeData } from '../utils/lastTime.js';
import paginate from '../utils/paginate.js';

Parser.config = 'moegirl';

const TIME_KEY = 'fix-anchor';
const TARGET_NAMESPACES = '0|10|14';
const NOBOTS_REGEX = /\{\{(?:[Nn]obots|[Bb]ots\|(?:allow=none|deny=[^}]*(?:机娘星海酱|all)))\}\}/;

/**
 * Parse CLI arguments (`--dry-run`, `--check-page=...`, `--only-modify-pages=...`, `--limit=...`).
 *
 * @returns {{ dryRun: boolean, checkPage: string | null, onlyModifyPages: Set<string> | null, limit: number }}
 */
function parseArgs() {
	const dryRun = argv.includes('--dry-run') || ['1', 'true'].includes(String(env.DRY_RUN).toLowerCase());
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
	return { dryRun, checkPage, onlyModifyPages, limit };
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
 * Compute unambiguous section anchor rename map from recent revisions of `title`.
 *
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {string} title
 * @param {string} sinceIso
 * @returns {Promise<Map<string, string>>}
 */
async function computePageRenameMap(api, title, sinceIso) {
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
		return new Map();
	}

	// Chronological order: oldest -> newest
	const chronological = [...revs].reverse();
	const sinceMs = Date.parse(sinceIso);
	const firstInWindowIdx = chronological.findIndex((r) => Date.parse(r.timestamp) >= sinceMs);
	const startIdx = firstInWindowIdx > 0 ? firstInWindowIdx - 1 : 0;
	const relevant = chronological.slice(startIdx);
	if (relevant.length < 2) {
		return new Map();
	}

	const anchorSnapshots = relevant.map((r) => extractAnchors(r.content));
	const stepRenames = [];
	for (let i = 1; i < anchorSnapshots.length; i++) {
		const step = detectSectionRenames(anchorSnapshots[i - 1], anchorSnapshots[i]);
		if (step.size) {
			stepRenames.push(step);
		}
	}
	if (!stepRenames.length) {
		return new Map();
	}

	const finalAnchors = anchorSnapshots[anchorSnapshots.length - 1].all;
	return buildRenameMap(stepRenames, finalAnchors);
}

/**
 * Fix broken anchor links on candidate pages for a single target page.
 *
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {string} targetTitle
 * @param {Map<string, string>} renameMap
 * @param {{ dryRun: boolean, onlyModifyPages: Set<string> | null }} opts
 */
async function processTargetPage(api, targetTitle, renameMap, { dryRun, onlyModifyPages }) {
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
		if (!result.changed) {
			return;
		}

		const summary = `机器人：修复指向[[${targetTitle}]]的失效章节锚点（${result.replacements.length}处）`;
		if (dryRun) {
			console.log(`[DRY-RUN] Would edit [[${pageTitle}]] (${summary}):`);
			for (const r of result.replacements) {
				console.log(`  - ${r.from} => ${r.to}`);
			}
			return;
		}

		await api.postWithToken('csrf', {
			action: 'edit',
			title: pageTitle,
			text: result.content,
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
	});
}

(async () => {
	const { dryRun, checkPage, onlyModifyPages, limit } = parseArgs();
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
		const renameMap = await computePageRenameMap(api, targetTitle, sinceIso);
		if (!renameMap.size) {
			return;
		}
		console.log(`Detected anchor rename(s) on [[${targetTitle}]]:`, Object.fromEntries(renameMap));
		await processTargetPage(api, targetTitle, renameMap, { dryRun, onlyModifyPages });
	});

	if (!dryRun && !checkPage && timeData) {
		await editTimeData(timeData, TIME_KEY, nowIso);
	}

	console.log(`End time: ${new Date().toISOString()}`);
})();
