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

export {
	detectSectionChanges,
	detectSectionRenames,
	buildRenameMap,
	type AnchorSet,
} from './diff.ts';

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
 * in `brokenAnchors`, and format them for `{{Broken anchors}}` talk-page notices.
 */
function findBrokenAnchorLinks(
	content: string,
	normalizedTargetTitles: Set<string>,
	brokenAnchors: Map<string, number | undefined> | Set<string>,
	isTargetPage = false,
): string[] {
	if (!brokenAnchors.size) {
		return [];
	}
	const root = Parser.parse(content);
	const found = new Map<string, string>();
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
		const key = `[[${titlePart}#${normFragment}]]`;
		if (!found.has(key)) {
			const rawLink = link.toString();
			const displayAnchor = normFragment.replace(/_/g, ' ');
			const revid = brokenAnchors instanceof Map ? brokenAnchors.get(normFragment) : undefined;
			const entry = revid !== undefined
				? `<nowiki>${rawLink}</nowiki> 锚点（${displayAnchor}）[[Special:Diff/${revid}|已被删除]]。`
				: `<nowiki>${rawLink}</nowiki> 锚点（${displayAnchor}）已失效。`;
			found.set(key, entry);
		}
	}
	return [...found.values()];
}

export {
	updateBrokenAnchorsTalkPage,
	parseBrokenAnchorLine,
	loadFixAnchorConfig,
} from './talkPage.ts';

export {
	normalizeAnchor,
	extractAnchors,
	rewriteAnchorLinks,
	findBrokenAnchorLinks,
};
