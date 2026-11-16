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
		const idVal = el.getAttr?.('id');
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
function levenshtein(a, b) {
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
function anchorDistanceScore(from, to) {
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
function detectSectionChanges(oldAnchors, newAnchors) {
	const removedList = oldAnchors.headings.filter((h) => !newAnchors.all.has(h));
	const addedList = newAnchors.headings.filter((h) => !oldAnchors.all.has(h));
	const renames = new Map();

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
function detectSectionRenames(oldAnchors, newAnchors) {
	return detectSectionChanges(oldAnchors, newAnchors).renames;
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
function findBrokenAnchorLinks(content, normalizedTargetTitles, brokenAnchors, isTargetPage = false) {
	if (!brokenAnchors.size) {
		return [];
	}
	const root = Parser.parse(content);
	const found = new Set();
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
 * - Removes the entire `{{Broken anchors}}` template if `links` becomes empty.
 *
 * @param {string} talkContent
 * @param {object} options
 * @param {string[]} [options.addLinks=[]]
 * @param {(title: string, anchor: string) => boolean} [options.isStillBroken]
 * @returns {{ changed: boolean, content: string, addedCount: number, removedCount: number, templateRemoved: boolean }}
 */
function updateBrokenAnchorsTalkPage(talkContent, { addLinks = [], isStillBroken = () => true }) {
	const BROKEN_ANCHORS_RE = /^Template:Broken[ _]anchors$/i;
	const root = Parser.parse(talkContent);
	const template = root.querySelectorAll('template').find((t) => BROKEN_ANCHORS_RE.test(t.name));

	let addedCount = 0;
	let removedCount = 0;
	let templateRemoved = false;

	if (!template) {
		if (!addLinks.length) {
			return { changed: false, content: talkContent, addedCount: 0, removedCount: 0, templateRemoved: false };
		}
		const block = `{{Broken anchors\n|links=\n${addLinks.map((l) => `* ${l}`).join('\n')}\n}}`;
		const newContent = talkContent.trim() ? `${block}\n${talkContent}` : block;
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
		changed: addedCount > 0 || removedCount > 0 || templateRemoved,
		content: newContent,
		addedCount,
		removedCount,
		templateRemoved,
	};
}

const DEFAULT_ANCHOR_CONFIG = {
	archiveTemplates: ['Archives', 'Archive box', '存档'],
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
async function loadFixAnchorConfig(api) {
	try {
		const { data } = await api.post({
			prop: 'revisions',
			titles: 'User:星海子/BotConfig/fixArchiveAnchor.json',
			rvprop: 'content',
		}, { retry: 15 });
		const page = Object.values(data?.query?.pages || {})[0];
		const raw = page?.revisions?.[0]?.content;
		if (!raw) {
			return { ...DEFAULT_ANCHOR_CONFIG };
		}
		const parsed = JSON.parse(raw);
		return {
			archiveTemplates: Array.isArray(parsed.archiveTemplates) ? parsed.archiveTemplates : DEFAULT_ANCHOR_CONFIG.archiveTemplates,
			archivePages: Array.isArray(parsed.archivePages) ? parsed.archivePages : DEFAULT_ANCHOR_CONFIG.archivePages,
			ignorePages: Array.isArray(parsed.ignorePages) ? parsed.ignorePages : DEFAULT_ANCHOR_CONFIG.ignorePages,
		};
	} catch (err) {
		console.warn('Failed to load User:星海子/BotConfig/fixArchiveAnchor.json, using defaults:', err?.message || err);
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
