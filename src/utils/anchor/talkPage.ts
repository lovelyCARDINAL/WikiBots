import type { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import { normalizeAnchor } from './index.ts';

interface UpdateBrokenAnchorsOptions {
	addLinks?: string[];
	isStillBroken?: (title: string, anchor: string) => boolean;
	removeTemplate?: string;
	subjectTitle?: string;
}

/**
 * Extract normalized `{ title, anchor }` from a `{{Broken anchors}}` list line,
 * supporting both `<nowiki>[[Title#Anchor|...]]</nowiki> ...` and legacy `[[Title#Anchor]]` entries.
 */
function parseBrokenAnchorLine(line: string, defaultTitle?: string): { title: string; anchor: string } | null {
	const root = Parser.parse(line);
	const nowiki = root.querySelector<Parser.ExtToken>('ext#nowiki');
	const link = nowiki && typeof nowiki.innerText === 'string'
		? Parser.parse(nowiki.innerText).querySelector('link')
		: root.querySelector('link');
	if (!link?.fragment) {
		return null;
	}
	const rawTitle = link.name || defaultTitle;
	if (!rawTitle) {
		return null;
	}
	return {
		title: Parser.normalizeTitle(rawTitle).title,
		anchor: normalizeAnchor(link.fragment),
	};
}

/**
 * Remove a template token and collapse its trailing newline when it occupied its own line.
 */
function removeTemplateCleanly(tpl: Parser.TranscludeToken): void {
	const prev = tpl.previousSibling;
	const next = tpl.nextSibling;
	const atLineStart = !prev || prev.type === 'text' && /\n$/.test(prev.data);
	if (atLineStart && next?.type === 'text' && next.data.startsWith('\n')) {
		next.replaceData(next.data.slice(1));
	}
	tpl.remove();
}

function removeTemplatesByName(root: Parser.Token, templateName: string): boolean {
	const targetName = Parser.normalizeTitle(templateName).title;
	let removed = false;
	for (const tpl of root.querySelectorAll<Parser.TranscludeToken>('template')) {
		if (Parser.normalizeTitle(tpl.name).title === targetName) {
			removeTemplateCleanly(tpl);
			removed = true;
		}
	}
	return removed;
}

function pruneExistingLinks(
	rawLinks: string,
	isStillBroken: (title: string, anchor: string) => boolean,
	subjectTitle?: string,
): { keptLines: string[]; existingNormalized: Set<string>; removedCount: number } {
	const keptLines: string[] = [];
	const existingNormalized = new Set<string>();
	let removedCount = 0;

	for (const line of rawLinks.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
		const parsed = parseBrokenAnchorLine(line, subjectTitle);
		if (!parsed) {
			keptLines.push(line);
			continue;
		}
		if (!isStillBroken(parsed.title, parsed.anchor)) {
			removedCount++;
			continue;
		}
		existingNormalized.add(`[[${parsed.title}#${parsed.anchor}]]`);
		keptLines.push(line);
	}
	return { keptLines, existingNormalized, removedCount };
}

function appendNewLinks(
	addLinks: string[],
	existingNormalized: Set<string>,
	keptLines: string[],
	subjectTitle?: string,
): number {
	let addedCount = 0;
	for (const newLink of addLinks) {
		const parsed = parseBrokenAnchorLine(newLink, subjectTitle);
		const key = parsed ? `[[${parsed.title}#${parsed.anchor}]]` : newLink;
		if (!existingNormalized.has(key)) {
			existingNormalized.add(key);
			keptLines.push(`* ${newLink}`);
			addedCount++;
		}
	}
	return addedCount;
}

/**
 * Update or remove `{{Broken anchors|links=...}}` on a talk page using wikiparser-node.
 */
function updateBrokenAnchorsTalkPage(
	talkContent: string,
	{ addLinks = [], isStillBroken = () => true, removeTemplate = '', subjectTitle }: UpdateBrokenAnchorsOptions = {},
): { changed: boolean; content: string; addedCount: number; removedCount: number; templateRemoved: boolean } {
	const BROKEN_ANCHORS_RE = /^Template:Broken[ _]anchors$/i;
	const root = Parser.parse(talkContent);
	const removedNoticeTpl = addLinks.length > 0 && removeTemplate
		? removeTemplatesByName(root, removeTemplate)
		: false;

	const template = root.querySelectorAll<Parser.TranscludeToken>('template').find((t) => BROKEN_ANCHORS_RE.test(t.name));
	if (!template) {
		if (!addLinks.length) {
			return { changed: false, content: talkContent, addedCount: 0, removedCount: 0, templateRemoved: false };
		}
		const cleanedTalk = root.toString();
		const block = `{{Broken anchors\n|links=\n${addLinks.map((l) => `* ${l}`).join('\n')}\n}}`;
		return {
			changed: true,
			content: cleanedTalk.trim() ? `${block}\n${cleanedTalk}` : block,
			addedCount: addLinks.length,
			removedCount: 0,
			templateRemoved: false,
		};
	}

	const { keptLines, existingNormalized, removedCount } = pruneExistingLinks(
		template.getValue('links') || '',
		isStillBroken,
		subjectTitle,
	);
	const addedCount = appendNewLinks(addLinks, existingNormalized, keptLines, subjectTitle);

	let templateRemoved = false;
	if (keptLines.length === 0) {
		removeTemplateCleanly(template);
		templateRemoved = true;
	} else if (addedCount > 0 || removedCount > 0) {
		template.setValue('links', `\n${keptLines.join('\n')}\n`);
	}

	return {
		changed: addedCount > 0 || removedCount > 0 || templateRemoved || removedNoticeTpl,
		content: root.toString(),
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
	updateBrokenAnchorsTalkPage,
	parseBrokenAnchorLine,
	loadFixAnchorConfig,
};
