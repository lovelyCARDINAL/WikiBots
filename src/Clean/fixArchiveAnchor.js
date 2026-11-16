import process from 'process';
import Parser from 'wikiparser-node';
import {
	extractAnchors,
	rewriteAnchorLinks,
	loadFixAnchorConfig,
} from '../utils/anchor.js';
import mapLimit from '../utils/concurrency.js';
import { createAndLogin } from '../utils/createApi.js';
import paginate from '../utils/paginate.js';

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
async function getTargetTitleSet(api, title) {
	const titles = new Set([Parser.normalizeTitle(title).title]);
	for await (const data of paginate(api, {
		prop: 'redirects',
		titles: title,
		rdlimit: 'max',
	})) {
		for (const page of Object.values(data?.query?.pages || {})) {
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
 * Collect pages that transclude any of `archiveTemplates` in project/help namespaces
 * merged with explicit `archivePages` from config.
 *
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {{ archiveTemplates: string[], archivePages: string[], ignorePages: string[] }} botConfig
 * @returns {Promise<string[]>}
 */
async function collectArchiveBoards(api, botConfig) {
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
				if (item.title) {
					const norm = Parser.normalizeTitle(item.title).title;
					// Skip archive subpages themselves
					if (!norm.includes('/存档') && !/\/Archive/i.test(norm)) {
						boards.add(norm);
					}
				}
			}
		}
	}

	return [...boards].filter((t) => !ignored.has(t));
}

/**
 * Build a map from archived section anchor -> unique archive subpage `{ title, anchor }`.
 * Anchors still present on the main board or appearing in multiple archives are omitted.
 *
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {string} boardTitle
 * @returns {Promise<Map<string, { title: string, anchor: string }>>}
 */
async function buildArchiveMap(api, boardTitle) {
	const parsed = Parser.normalizeTitle(boardTitle);
	const { data: boardData } = await api.post({
		prop: 'revisions',
		titles: boardTitle,
		rvprop: 'content',
	}, { retry: 15 });
	const boardContent = Object.values(boardData?.query?.pages || {})[0]?.revisions?.[0]?.content;
	if (!boardContent) {
		return new Map();
	}

	const currentAnchors = extractAnchors(boardContent).all;
	const subpages = [];
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

	if (!subpages.length) {
		return new Map();
	}

	const anchorOwners = new Map();
	await mapLimit(subpages, 5, async (subTitle) => {
		const { data } = await api.post({
			prop: 'revisions',
			titles: subTitle,
			rvprop: 'content',
		}, { retry: 15 });
		const subContent = Object.values(data?.query?.pages || {})[0]?.revisions?.[0]?.content;
		if (!subContent) {
			return;
		}
		const { all } = extractAnchors(subContent);
		for (const anchor of all) {
			if (currentAnchors.has(anchor)) {
				continue;
			}
			let owners = anchorOwners.get(anchor);
			if (!owners) {
				owners = new Set();
				anchorOwners.set(anchor, owners);
			}
			owners.add(subTitle);
		}
	});

	const archiveMap = new Map();
	for (const [anchor, owners] of anchorOwners) {
		if (owners.size === 1) {
			const [subTitle] = owners;
			archiveMap.set(anchor, { title: subTitle, anchor });
		}
	}
	return archiveMap;
}

/**
 * Rewrite backlinks pointing to archived anchors of `boardTitle`.
 *
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {string} boardTitle
 */
async function processArchiveBoard(api, boardTitle) {
	const archiveMap = await buildArchiveMap(api, boardTitle);
	if (!archiveMap.size) {
		return;
	}

	const targetTitles = await getTargetTitleSet(api, boardTitle);
	const backlinks = new Set();
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

	if (!backlinks.size) {
		return;
	}

	console.log(`[[${boardTitle}]]: ${archiveMap.size} archived anchor(s), checking ${backlinks.size} backlink(s)...`);

	await mapLimit([...backlinks], 5, async (pageTitle) => {
		const { data } = await api.post({
			prop: 'revisions',
			titles: pageTitle,
			rvprop: 'content',
		}, { retry: 15 });
		const content = Object.values(data?.query?.pages || {})[0]?.revisions?.[0]?.content;
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
			console.error(`Error processing archive board [[${boardTitle}]]:`, err?.message || err);
		}
	});

	console.log(`End time: ${new Date().toISOString()}`);
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
