import process from 'process';
import type { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import {
	extractAnchors,
	rewriteAnchorLinks,
	loadFixAnchorConfig,
} from '../utils/anchor/index.ts';
import mapLimit from '../utils/common/concurrency.ts';
import { createAndLogin } from '../utils/core/createApi.ts';
import paginate from '../utils/core/paginate.ts';

Parser.config = 'moegirl';

const BACKLINK_NAMESPACES = '0|4|10|12|14';
const ARCHIVE_DISCOVERY_NAMESPACES = '4|12';
const NOBOTS_REGEX = /\{\{(?:[Nn]obots|[Bb]ots\|(?:allow=none|deny=[^}]*(?:星海-adminbot|all)))\}\}/;

/**
 * Fetch normalized title set (page itself + redirects pointing to it).
 *
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {string} title
 * @returns {Promise<Set<string>>}
 */
async function getTargetTitleSet(api: MediaWikiApi, title: string): Promise<Set<string>> {
	const titles = new Set([Parser.normalizeTitle(title).title]);
	for await (const data of paginate(api, {
		prop: 'redirects',
		titles: title,
		rdlimit: 'max',
	})) {
		for (const page of Object.values((data?.query?.pages || {}) as Record<string, { redirects?: Array<{ title?: string }> }>)) {
			for (const rd of page.redirects || []) {
				if (rd.title) {
					titles.add(Parser.normalizeTitle(rd.title).title);
				}
			}
		}
	}
	return titles;
}

async function fetchPageContent(api: MediaWikiApi, title: string): Promise<string | undefined> {
	const { data } = await api.post<{
		query?: { pages?: Record<string, { revisions?: Array<{ content?: string }> }> };
	}>({
		prop: 'revisions',
		titles: title,
		rvprop: 'content',
	}, { retry: 15 });
	return Object.values(data?.query?.pages || {})[0]?.revisions?.[0]?.content;
}

async function collectArchiveBoards(
	api: MediaWikiApi,
	botConfig: { archiveTemplates: string[]; archivePages: string[]; ignorePages: string[] },
): Promise<string[]> {
	const ignored = new Set(botConfig.ignorePages.map((t) => Parser.normalizeTitle(t).title));
	const boards = new Set(botConfig.archivePages.map((t) => Parser.normalizeTitle(t).title));

	for (const tpl of botConfig.archiveTemplates) {
		const eititle = tpl.startsWith('Template:') ? tpl : `Template:${tpl}`;
		for await (const data of paginate(api, {
			list: 'embeddedin',
			eititle,
			einamespace: ARCHIVE_DISCOVERY_NAMESPACES,
			eifilterredir: 'nonredirects',
			eilimit: 'max',
		})) {
			for (const item of data?.query?.embeddedin || []) {
				if (!item.title) {
					continue;
				}
				const norm = Parser.normalizeTitle(item.title).title;
				if (!norm.includes('/存档') && !/\/Archive/i.test(norm)) {
					boards.add(norm);
				}
			}
		}
	}

	return [...boards].filter((t) => !ignored.has(t));
}

async function listSubpages(api: MediaWikiApi, boardTitle: string): Promise<string[]> {
	const parsed = Parser.normalizeTitle(boardTitle);
	const subpages: string[] = [];
	for await (const data of paginate(api, {
		list: 'allpages',
		apprefix: `${parsed.main}/`,
		apnamespace: String(parsed.ns),
		apfilterredir: 'nonredirects',
		aplimit: 'max',
	})) {
		for (const page of data?.query?.allpages || []) {
			if (page.title) {
				subpages.push(page.title);
			}
		}
	}
	return subpages;
}

/**
 * Build a map from archived section anchor -> unique archive subpage `{ title, anchor }`.
 * Anchors still present on the main board or appearing in multiple archives are omitted.
 */
async function buildArchiveMap(
	api: MediaWikiApi,
	boardTitle: string,
): Promise<Map<string, { title: string; anchor: string }>> {
	const boardContent = await fetchPageContent(api, boardTitle);
	if (!boardContent) {
		return new Map();
	}

	const currentAnchors = extractAnchors(boardContent).all;
	const subpages = await listSubpages(api, boardTitle);
	if (!subpages.length) {
		return new Map();
	}

	const anchorOwners = new Map<string, Set<string>>();
	await mapLimit(subpages, 5, async (subTitle) => {
		const subContent = await fetchPageContent(api, subTitle);
		if (!subContent) {
			return;
		}
		for (const anchor of extractAnchors(subContent).all) {
			if (currentAnchors.has(anchor)) {
				continue;
			}
			const owners = anchorOwners.get(anchor) ?? new Set<string>();
			owners.add(subTitle);
			anchorOwners.set(anchor, owners);
		}
	});

	const archiveMap = new Map<string, { title: string; anchor: string }>();
	for (const [anchor, owners] of anchorOwners) {
		if (owners.size === 1) {
			const [subTitle] = owners;
			archiveMap.set(anchor, { title: subTitle, anchor });
		}
	}
	return archiveMap;
}

async function collectBoardBacklinks(api: MediaWikiApi, boardTitle: string, targetTitles: Set<string>): Promise<Set<string>> {
	const backlinks = new Set<string>();
	for (const targetTitle of targetTitles) {
		for await (const data of paginate(api, {
			list: 'backlinks',
			bltitle: targetTitle,
			blnamespace: BACKLINK_NAMESPACES,
			blfilterredir: 'nonredirects',
			bllimit: 'max',
		})) {
			for (const item of data?.query?.backlinks || []) {
				if (item.title && !item.title.startsWith(`${boardTitle}/`)) {
					backlinks.add(item.title);
				}
			}
		}
	}
	return backlinks;
}

async function processArchiveBoard(api: MediaWikiApi, boardTitle: string): Promise<void> {
	const archiveMap = await buildArchiveMap(api, boardTitle);
	if (!archiveMap.size) {
		return;
	}

	const targetTitles = await getTargetTitleSet(api, boardTitle);
	const backlinks = await collectBoardBacklinks(api, boardTitle, targetTitles);
	if (!backlinks.size) {
		return;
	}

	console.log(`[[${boardTitle}]]: ${archiveMap.size} archived anchor(s), checking ${backlinks.size} backlink(s)...`);

	await mapLimit([...backlinks], 5, async (pageTitle) => {
		const content = await fetchPageContent(api, pageTitle);
		if (!content || NOBOTS_REGEX.test(content.replace(/\s+/g, ''))) {
			return;
		}

		const result = rewriteAnchorLinks(content, targetTitles, archiveMap, false);
		if (!result.changed) {
			return;
		}

		const summary = `修复指向[[${boardTitle}]]已存档章节的链接（${result.replacements.length}处）`;
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
	console.log(`Start time: ${new Date().toISOString()}`);

	const api = await createAndLogin('zh', 'abot');
	const botConfig = await loadFixAnchorConfig(api);
	const boards = await collectArchiveBoards(api, botConfig);

	console.log(`Checking ${boards.length} archive board(s)...`);

	await mapLimit(boards, 2, async (boardTitle) => {
		try {
			await processArchiveBoard(api, boardTitle);
		} catch (err) {
			console.error(`Error processing archive board [[${boardTitle}]]:`, err instanceof Error ? err.message : String(err));
			process.exitCode = 1;
		}
	});

	console.log(`End time: ${new Date().toISOString()}`);
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
