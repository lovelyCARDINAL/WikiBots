import type { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';

Parser.config = 'moegirl';

interface AnchorSet {
	headings: string[];
	all: Set<string>;
}

type RenameTarget = string | { title: string; anchor: string };

/**
 * Safely decode URI-encoded anchor fragments without throwing on malformed %.
 */
function decodeURIComponentSafe(str: string): string {
	try {
		return decodeURIComponent(str.replaceAll('.', '%'));
	} catch {
		try {
			return decodeURIComponent(str);
		} catch {
			return str;
		}
	}
}

/**
 * Normalize a MediaWiki section/fragment identifier for comparison.
 *
 * @param {string} anchor
 * @returns {string}
 */
function normalizeAnchor(anchor: string): string {
	return decodeURIComponentSafe(anchor)
		.trim()
		.replace(/[\s_]+/g, '_');
}

/**
 * Extract all valid anchors (section headings, {{anchor}} templates, HTML id attributes)
 * from wikitext using wikiparser-node.
 *
 * @param {string} wikitext
 * @returns {{ headings: string[], all: Set<string> }}
 */
function extractAnchors(wikitext: string): AnchorSet {
	const root = Parser.parse(wikitext);
	const headings: string[] = [];
	const all = new Set<string>();
	const seenHeadingCount = new Map<string, number>();

	for (const heading of root.querySelectorAll('heading')) {
		const rawId = heading.id?.trim();
		if (!rawId) {
			continue;
		}
		const base = normalizeAnchor(rawId);
		if (!base) {
			continue;
		}
		const count = (seenHeadingCount.get(base) || 0) + 1;
		seenHeadingCount.set(base, count);
		const finalAnchor = count === 1 ? base : `${base}_${count}`;
		headings.push(finalAnchor);
		all.add(finalAnchor);
	}

	// Explicit {{anchor|...}} templates
	const ANCHOR_TEMPLATE_RE = /^Template:anchor$/i;
	for (const temp of root.querySelectorAll('template')) {
		if (!ANCHOR_TEMPLATE_RE.test(temp.name)) {
			continue;
		}
		for (const arg of temp.getAllArgs()) {
			const val = normalizeAnchor(arg.value || '');
			if (val) {
				all.add(val);
			}
		}
	}

	// Explicit HTML id="..." attributes
	for (const el of root.querySelectorAll('html[id]')) {
		const idVal = (el as { getAttr?: (name: string) => unknown }).getAttr?.('id');
		if (typeof idVal === 'string' && idVal.trim()) {
			all.add(normalizeAnchor(idVal));
		}
	}

	return { headings, all };
}

/**
 * Compute Levenshtein edit distance between two strings.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshtein(a: string, b: string): number {
	if (a === b) {
		return 0;
	}
	if (!a.length) {
		return b.length;
	}
	if (!b.length) {
		return a.length;
	}
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const curr = [i];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
		}
		prev = curr;
	}
	return prev[b.length];
}

/**
 * Compute normalized similarity distance in [0, 1] (smaller = more similar).
 * Grants a strong bonus when the shorter anchor is contained in the longer one.
 *
 * @param {string} from
 * @param {string} to
 * @returns {number}
 */
function anchorDistanceScore(from: string, to: string): number {
	const a = from.toLowerCase();
	const b = to.toLowerCase();
	const dist = levenshtein(a, b);
	const maxLen = Math.max(a.length, b.length, 1);
	const minLen = Math.min(a.length, b.length);
	if (minLen >= 2 && (a.includes(b) || b.includes(a))) {
		return Math.min(0.35, dist / (maxLen * 2));
	}
	return 2 * dist / (a.length + b.length || 1);
}

/**
 * Compare two revisions of a page and return:
 * - `renames`: similarity-verified section renames (supports 1-to-1 and multi-section edits)
 * - `removed`: heading anchors removed without a confident match
 *
 * @param {{ headings: string[], all: Set<string> }} oldAnchors
 * @param {{ headings: string[], all: Set<string> }} newAnchors
 * @returns {{ renames: Map<string, string>, removed: string[] }}
 */
function detectSectionChanges(
	oldAnchors: AnchorSet,
	newAnchors: AnchorSet,
): { renames: Map<string, string>; removed: string[] } {
	const removedList = oldAnchors.headings.filter((h) => !newAnchors.all.has(h));
	const addedList = newAnchors.headings.filter((h) => !oldAnchors.all.has(h));
	const renames = new Map<string, string>();

	if (!removedList.length || !addedList.length) {
		return { renames, removed: removedList };
	}

	const SIMILARITY_THRESHOLD = 0.75;
	const candidates = [];
	for (const from of removedList) {
		for (const to of addedList) {
			const score = anchorDistanceScore(from, to);
			if (score < SIMILARITY_THRESHOLD) {
				candidates.push({ score, from, to });
			}
		}
	}
	candidates.sort((x, y) => x.score - y.score);

	const usedFrom = new Set();
	const usedTo = new Set();
	for (const { from, to } of candidates) {
		if (!usedFrom.has(from) && !usedTo.has(to)) {
			usedFrom.add(from);
			usedTo.add(to);
			renames.set(from, to);
		}
	}

	const remainingRemoved = removedList.filter((h) => !usedFrom.has(h));
	return { renames, removed: remainingRemoved };
}

/**
 * Backward-compatible wrapper returning only the unambiguous 1-to-1 rename map.
 *
 * @param {{ headings: string[], all: Set<string> }} oldAnchors
 * @param {{ headings: string[], all: Set<string> }} newAnchors
 * @returns {Map<string, string>}
 */
function detectSectionRenames(oldAnchors: AnchorSet, newAnchors: AnchorSet): Map<string, string> {
	return detectSectionChanges(oldAnchors, newAnchors).renames;
}

function buildRenameMap(
	stepRenames: Array<Map<string, string>>,
	finalAnchors: Set<string>,
): Map<string, string> {
	const combined = new Map<string, string>();
	for (const step of stepRenames) {
		for (const [oldA, newA] of step) {
			for (const [k, v] of combined) {
				if (v === oldA) {
					combined.set(k, newA);
				}
			}
			if (!combined.has(oldA)) {
				combined.set(oldA, newA);
			}
		}
	}

	for (const [oldA, newA] of [...combined]) {
		if (oldA === newA || finalAnchors.has(oldA) || !finalAnchors.has(newA)) {
			combined.delete(oldA);
		}
	}
	return combined;
}

/**
 * Rewrite broken section links on a page that point to any of targetTitles
 * (the target page itself and its redirects) using renameMap.
 *
 * `renameMap` values may be:
 * - `string`: same-page anchor rename (`newAnchor`)
 * - `{ title: string, anchor: string }`: cross-page rename (e.g. moved to an archive subpage)
 *
 * @param {string} content
 * @param {Set<string>} normalizedTargetTitles
 * @param {Map<string, string | { title: string, anchor: string }>} renameMap
 * @param {boolean} [isTargetPage=false]
 * @returns {{ changed: boolean, content: string, replacements: Array<{ from: string, to: string }> }}
 */
function rewriteAnchorLinks(
	content: string,
	normalizedTargetTitles: Set<string>,
	renameMap: Map<string, RenameTarget>,
	isTargetPage = false,
): { changed: boolean; content: string; replacements: Array<{ from: string; to: string }> } {
	if (!renameMap.size) {
		return { changed: false, content, replacements: [] };
	}

	const root = Parser.parse(content);
	const replacements: Array<{ from: string; to: string }> = [];

	for (const link of root.querySelectorAll('link')) {
		const rawFragment = link.fragment;
		if (!rawFragment) {
			continue;
		}
		const normFragment = normalizeAnchor(rawFragment);
		const mapping = renameMap.get(normFragment);
		if (!mapping) {
			continue;
		}

		const isSelfSection = !link.name && isTargetPage;
		const normalizedLinkName = link.name ? Parser.normalizeTitle(link.name).title : '';
		if (!isSelfSection && !normalizedTargetTitles.has(normalizedLinkName)) {
			continue;
		}

		let newTarget;
		if (typeof mapping === 'string') {
			newTarget = link.name ? `${link.name}#${mapping}` : `#${mapping}`;
		} else {
			newTarget = `${mapping.title}#${mapping.anchor}`;
		}

		const before = link.toString();
		link.setTarget(newTarget);
		const after = link.toString();
		if (before !== after) {
			replacements.push({ from: before, to: after });
		}
	}

	return {
		changed: replacements.length > 0,
		content: replacements.length > 0 ? root.toString() : content,
		replacements,
	};
}

/**
 * Find links in `content` that point to `normalizedTargetTitles` with a fragment
 * in `brokenAnchors`.
 *
 * @param {string} content
 * @param {Set<string>} normalizedTargetTitles
 * @param {Set<string>} brokenAnchors
 * @param {boolean} [isTargetPage=false]
 * @returns {string[]} normalized `[[Title#Anchor]]` strings
 */
function findBrokenAnchorLinks(
	content: string,
	normalizedTargetTitles: Set<string>,
	brokenAnchors: Set<string>,
	isTargetPage = false,
): string[] {
	if (!brokenAnchors.size) {
		return [];
	}
	const root = Parser.parse(content);
	const found = new Set<string>();
	const primaryTitle = [...normalizedTargetTitles][0] || '';

	for (const link of root.querySelectorAll('link')) {
		if (!link.fragment) {
			continue;
		}
		const normFragment = normalizeAnchor(link.fragment);
		if (!brokenAnchors.has(normFragment)) {
			continue;
		}
		const isSelfSection = !link.name && isTargetPage;
		const normalizedLinkName = link.name ? Parser.normalizeTitle(link.name).title : '';
		if (!isSelfSection && !normalizedTargetTitles.has(normalizedLinkName)) {
			continue;
		}
		const titlePart = link.name ? normalizedLinkName : primaryTitle;
		found.add(`[[${titlePart}#${normFragment}]]`);
	}
	return [...found];
}

/**
 * Update or remove `{{Broken anchors|links=...}}` on a talk page using wikiparser-node.
 * - Prunes entries for which `isStillBroken(title, anchor)` returns `false`.
 * - Appends new `addLinks` (each like `[[Page#Anchor]]`) not already listed.
 * - Removes `removeTemplate` (e.g. `Template:即将删除`) when adding/reminding broken anchors.
 * - Removes the entire `{{Broken anchors}}` template if `links` becomes empty.
 *
 * @param {string} talkContent
 * @param {object} options
 * @param {string[]} [options.addLinks=[]]
 * @param {(title: string, anchor: string) => boolean} [options.isStillBroken]
 * @param {string} [options.removeTemplate]
 * @returns {{ changed: boolean, content: string, addedCount: number, removedCount: number, templateRemoved: boolean }}
 */
interface UpdateBrokenAnchorsOptions {
	addLinks?: string[];
	isStillBroken?: (title: string, anchor: string) => boolean;
	removeTemplate?: string;
}

function updateBrokenAnchorsTalkPage(
	talkContent: string,
	{ addLinks = [], isStillBroken = () => true, removeTemplate = '' }: UpdateBrokenAnchorsOptions = {},
): { changed: boolean; content: string; addedCount: number; removedCount: number; templateRemoved: boolean } {
	const BROKEN_ANCHORS_RE = /^Template:Broken[ _]anchors$/i;
	const root = Parser.parse(talkContent);

	let removedNoticeTpl = false;
	if (addLinks.length > 0 && removeTemplate) {
		const targetRemoveName = Parser.normalizeTitle(removeTemplate).title;
		for (const tpl of root.querySelectorAll('template')) {
			if (Parser.normalizeTitle(tpl.name).title === targetRemoveName) {
				const prev = tpl.previousSibling;
				const next = tpl.nextSibling;
				const atLineStart = !prev || prev.type === 'text' && /\n$/.test(prev.data);
				if (atLineStart && next?.type === 'text' && next.data.startsWith('\n')) {
					next.replaceData(next.data.slice(1));
				}
				tpl.remove();
				removedNoticeTpl = true;
			}
		}
	}

	const template = root.querySelectorAll('template').find((t) => BROKEN_ANCHORS_RE.test(t.name));

	let addedCount = 0;
	let removedCount = 0;
	let templateRemoved = false;

	if (!template) {
		if (!addLinks.length) {
			return { changed: false, content: talkContent, addedCount: 0, removedCount: 0, templateRemoved: false };
		}
		const cleanedTalk = root.toString();
		const block = `{{Broken anchors\n|links=\n${addLinks.map((l) => `* ${l}`).join('\n')}\n}}`;
		const newContent = cleanedTalk.trim() ? `${block}\n${cleanedTalk}` : block;
		return {
			changed: true,
			content: newContent,
			addedCount: addLinks.length,
			removedCount: 0,
			templateRemoved: false,
		};
	}

	const rawLinks = template.getValue('links') || '';
	const existingLines = rawLinks
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);

	const keptLines = [];
	const existingNormalized = new Set();

	for (const line of existingLines) {
		const parsedLine = Parser.parse(line);
		const link = parsedLine.querySelector('link');
		if (!link || !link.name || !link.fragment) {
			keptLines.push(line);
			continue;
		}
		const normTitle = Parser.normalizeTitle(link.name).title;
		const normFragment = normalizeAnchor(link.fragment);
		if (!isStillBroken(normTitle, normFragment)) {
			removedCount++;
			continue;
		}
		existingNormalized.add(`[[${normTitle}#${normFragment}]]`);
		keptLines.push(line);
	}

	for (const newLink of addLinks) {
		const parsedNew = Parser.parse(newLink);
		const link = parsedNew.querySelector('link');
		const key = link?.name && link?.fragment
			? `[[${Parser.normalizeTitle(link.name).title}#${normalizeAnchor(link.fragment)}]]`
			: newLink;
		if (!existingNormalized.has(key)) {
			existingNormalized.add(key);
			keptLines.push(`* ${newLink}`);
			addedCount++;
		}
	}

	if (keptLines.length === 0) {
		const prev = template.previousSibling;
		const next = template.nextSibling;
		const atLineStart = !prev || prev.type === 'text' && /\n$/.test(prev.data);
		if (atLineStart && next?.type === 'text' && next.data.startsWith('\n')) {
			next.replaceData(next.data.slice(1));
		}
		template.remove();
		templateRemoved = true;
	} else if (addedCount > 0 || removedCount > 0) {
		template.setValue('links', `\n${keptLines.join('\n')}\n`);
	}

	const newContent = root.toString();
	return {
		changed: addedCount > 0 || removedCount > 0 || templateRemoved || removedNoticeTpl,
		content: newContent,
		addedCount,
		removedCount,
		templateRemoved,
	};
}

const DEFAULT_ANCHOR_CONFIG = {
	archiveTemplates: [
		'ArchiveBox',
		'Archives',
		'Auto-archive',
		'档案馆',
		'提问求助区页顶/档案馆',
		'讨论版页顶/旧版/档案馆',
		'用户存档页顶',
	],
	archivePages: [],
	ignorePages: [],
};

/**
 * Load external JSON configuration from `User:星海子/BotConfig/fixArchiveAnchor.json`,
 * falling back to safe defaults if the page is missing or invalid.
 *
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @returns {Promise<{ archiveTemplates: string[], archivePages: string[], ignorePages: string[] }>}
 */
async function loadFixAnchorConfig(
	api: MediaWikiApi,
): Promise<{ archiveTemplates: string[]; archivePages: string[]; ignorePages: string[] }> {
	try {
		const { data } = await api.post<{
			query?: { pages?: Record<string, { revisions?: Array<{ content?: string }> }> };
		}>({
			prop: 'revisions',
			titles: 'User:星海子/BotConfig/fixArchiveAnchor.json',
			rvprop: 'content',
		}, { retry: 15 });
		const page = Object.values(data?.query?.pages || {})[0];
		const raw = page?.revisions?.[0]?.content;
		if (!raw) {
			return { ...DEFAULT_ANCHOR_CONFIG };
		}
		const parsed = JSON.parse(raw) as Partial<typeof DEFAULT_ANCHOR_CONFIG>;
		return {
			archiveTemplates: Array.isArray(parsed.archiveTemplates) ? parsed.archiveTemplates : DEFAULT_ANCHOR_CONFIG.archiveTemplates,
			archivePages: Array.isArray(parsed.archivePages) ? parsed.archivePages : DEFAULT_ANCHOR_CONFIG.archivePages,
			ignorePages: Array.isArray(parsed.ignorePages) ? parsed.ignorePages : DEFAULT_ANCHOR_CONFIG.ignorePages,
		};
	} catch (err) {
		console.warn('Failed to load User:星海子/BotConfig/fixArchiveAnchor.json, using defaults:', err instanceof Error ? err.message : String(err));
		return { ...DEFAULT_ANCHOR_CONFIG };
	}
}

export {
	normalizeAnchor,
	extractAnchors,
	detectSectionChanges,
	detectSectionRenames,
	buildRenameMap,
	rewriteAnchorLinks,
	findBrokenAnchorLinks,
	updateBrokenAnchorsTalkPage,
	loadFixAnchorConfig,
};
