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

function extractHeadingAnchors(root: Parser.Token, all: Set<string>): string[] {
	const headings: string[] = [];
	const seenHeadingCount = new Map<string, number>();

	for (const heading of root.querySelectorAll('heading')) {
		const rawId = heading.id?.trim();
		const base = rawId ? normalizeAnchor(rawId) : '';
		if (!base) {
			continue;
		}
		const count = (seenHeadingCount.get(base) || 0) + 1;
		seenHeadingCount.set(base, count);
		const finalAnchor = count === 1 ? base : `${base}_${count}`;
		headings.push(finalAnchor);
		all.add(finalAnchor);
	}
	return headings;
}

function extractTemplateAnchors(root: Parser.Token, all: Set<string>): void {
	const ANCHOR_TEMPLATE_RE = /^Template:anchor$/i;
	for (const temp of root.querySelectorAll<Parser.TranscludeToken>('template')) {
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
}

function extractHtmlIdAnchors(root: Parser.Token, all: Set<string>): void {
	for (const el of root.querySelectorAll('html[id]')) {
		const idVal = (el as { getAttr?: (name: string) => unknown }).getAttr?.('id');
		if (typeof idVal === 'string' && idVal.trim()) {
			all.add(normalizeAnchor(idVal));
		}
	}
}

/**
 * Extract all valid anchors (section headings, {{anchor}} templates, HTML id attributes)
 * from wikitext using wikiparser-node.
 */
function extractAnchors(wikitext: string): AnchorSet {
	const root = Parser.parse(wikitext);
	const all = new Set<string>();
	const headings = extractHeadingAnchors(root, all);
	extractTemplateAnchors(root, all);
	extractHtmlIdAnchors(root, all);
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

function resolveLinkRewriteTarget(
	link: Parser.LinkToken,
	normalizedTargetTitles: Set<string>,
	renameMap: Map<string, RenameTarget>,
	isTargetPage: boolean,
): string | null {
	if (!link.fragment) {
		return null;
	}
	const mapping = renameMap.get(normalizeAnchor(link.fragment));
	if (!mapping) {
		return null;
	}
	const isSelfSection = !link.name && isTargetPage;
	const normalizedLinkName = link.name ? Parser.normalizeTitle(link.name).title : '';
	if (!isSelfSection && !normalizedTargetTitles.has(normalizedLinkName)) {
		return null;
	}
	if (typeof mapping === 'string') {
		return link.name ? `${link.name}#${mapping}` : `#${mapping}`;
	}
	return `${mapping.title}#${mapping.anchor}`;
}

/**
 * Rewrite broken section links on a page that point to any of targetTitles
 * (the target page itself and its redirects) using renameMap.
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

	for (const link of root.querySelectorAll<Parser.LinkToken>('link')) {
		const newTarget = resolveLinkRewriteTarget(link, normalizedTargetTitles, renameMap, isTargetPage);
		if (!newTarget) {
			continue;
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
export {
	updateBrokenAnchorsTalkPage,
	loadFixAnchorConfig,
} from './talkPage.ts';

export {
	normalizeAnchor,
	extractAnchors,
	detectSectionChanges,
	detectSectionRenames,
	buildRenameMap,
	rewriteAnchorLinks,
	findBrokenAnchorLinks,
};
