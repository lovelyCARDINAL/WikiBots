import Parser from 'wikiparser-node';

Parser.config = 'moegirl';

/**
 * Safely decode URI-encoded anchor fragments without throwing on malformed %.
 *
 * @param {string} str
 * @returns {string}
 */
function decodeURIComponentSafe(str) {
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
function normalizeAnchor(anchor) {
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
function extractAnchors(wikitext) {
	const root = Parser.parse(wikitext);
	const headings = [];
	const all = new Set();
	const seenHeadingCount = new Map();

	for (const heading of root.querySelectorAll('heading')) {
		const rawText = heading.innerText?.trim();
		if (!rawText) {
			continue;
		}
		const base = normalizeAnchor(rawText);
		if (!base) {
			continue;
		}
		const count = (seenHeadingCount.get(base) || 0) + 1;
		seenHeadingCount.set(base, count);
		const finalAnchor = count === 1 ? base : `${base}_${count}`;
		headings.push(finalAnchor);
		all.add(finalAnchor);
	}

	// Explicit {{anchor|...}} / {{锚点|...}} / {{vanchor|...}} templates
	const ANCHOR_TEMPLATE_RE = /^Template:(?:anchor|vanchor|锚点|錨點)$/i;
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
		const idVal = el.getAttr?.('id');
		if (typeof idVal === 'string' && idVal.trim()) {
			all.add(normalizeAnchor(idVal));
		}
	}

	return { headings, all };
}

/**
 * Compare two revisions of a page and return unambiguous 1-to-1 section renames.
 * If multiple sections are added/removed simultaneously, returns an empty map to avoid
 * false positives (matching cewbot's conservative rename detection).
 *
 * @param {{ headings: string[], all: Set<string> }} oldAnchors
 * @param {{ headings: string[], all: Set<string> }} newAnchors
 * @returns {Map<string, string>} normalizedOldAnchor -> newHeadingAnchor
 */
function detectSectionRenames(oldAnchors, newAnchors) {
	const removed = oldAnchors.headings.filter((h) => !newAnchors.all.has(h));
	const added = newAnchors.headings.filter((h) => !oldAnchors.all.has(h));
	const renames = new Map();

	if (removed.length === 1 && added.length === 1) {
		renames.set(removed[0], added[0]);
	}
	return renames;
}

/**
 * Chain sequential revision renames (A -> B, B -> C => A -> C),
 * dropping mappings whose old anchor still exists in finalAnchors.
 *
 * @param {Array<Map<string, string>>} stepRenames
 * @param {Set<string>} finalAnchors
 * @returns {Map<string, string>}
 */
function buildRenameMap(stepRenames, finalAnchors) {
	const combined = new Map();
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
 * @param {string} content
 * @param {Set<string>} normalizedTargetTitles
 * @param {Map<string, string>} renameMap
 * @param {boolean} [isTargetPage=false]
 * @returns {{ changed: boolean, content: string, replacements: Array<{ from: string, to: string }> }}
 */
function rewriteAnchorLinks(content, normalizedTargetTitles, renameMap, isTargetPage = false) {
	if (!renameMap.size) {
		return { changed: false, content, replacements: [] };
	}

	const root = Parser.parse(content);
	const replacements = [];

	for (const link of root.querySelectorAll('link')) {
		const rawFragment = link.fragment;
		if (!rawFragment) {
			continue;
		}
		const normFragment = normalizeAnchor(rawFragment);
		const newAnchor = renameMap.get(normFragment);
		if (!newAnchor) {
			continue;
		}

		const isSelfSection = !link.name && isTargetPage;
		const normalizedLinkName = link.name ? Parser.normalizeTitle(link.name).title : '';
		if (!isSelfSection && !normalizedTargetTitles.has(normalizedLinkName)) {
			continue;
		}

		const newTarget = link.name ? `${link.name}#${newAnchor}` : `#${newAnchor}`;
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

export {
	normalizeAnchor,
	extractAnchors,
	detectSectionRenames,
	buildRenameMap,
	rewriteAnchorLinks,
};
