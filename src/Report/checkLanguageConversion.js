import process from 'process';
import { load as loadHtml } from 'cheerio';
import Parser from 'wikiparser-node';
import mapLimit from '../utils/concurrency.js';
import {
	normalizeGroupName,
	getGroupNameFromTitle,
	parseLuaCGroup,
	parseWikitextCGroup,
	processNoteTAArticle,
	updateInvalidCGroupTalkPage,
} from '../utils/conversion.js';
import { createAndLogin } from '../utils/createApi.js';
import paginate from '../utils/paginate.js';
import splitAndJoin from '../utils/splitAndJoin.js';

Parser.config = 'moegirl';

const MAIN_CATEGORY = 'Category:公共转换组模块';
const CONVERSION_LIST_PAGE = '萌娘百科:字词转换处理报告/各页面包含字词';
const DUPLICATED_REPORT_PAGE = '萌娘百科:字词转换处理报告/重复字词报告';
const UNREGISTERED_TEMPLATE = 'Template:Invalid CGroup';
const TAGS = 'Bot';
const MAX_VOCAB_LIST = 500;
const TOUCHED_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const NOBOTS_REGEX = /\{\{(?:[Nn]obots|[Bb]ots\|(?:allow=none|deny=[^}]*(?:星海-interfacebot|all)))\}\}/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Execute `api.post` with exponential backoff on transient transport errors (e.g. `fetch failed`).
 *
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {Record<string, unknown>} params
 * @param {number} [attempts=3]
 * @returns {Promise<any>}
 */
async function postWithBackoff(api, params, attempts = 3) {
	let lastErr;
	for (let i = 1; i <= attempts; i++) {
		try {
			return await api.post(params, { retry: 15 });
		} catch (err) {
			lastErr = err;
			if (i < attempts) {
				const delay = 1000 * 2 ** (i - 1);
				await sleep(delay);
			}
		}
	}
	throw lastErr;
}

/**
 * Traverse a category tree recursively to collect Module (828) and Template (10) pages,
 * tracking deprecated pages from subcategories whose title includes `已停用`.
 *
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {string} rootCategory
 * @returns {Promise<{ active: Array<{ title: string, ns: number }>, deprecated: Set<string> }>}
 */
async function collectCategoryTree(api, rootCategory) {
	const visitedCats = new Set();
	const queue = [{ title: rootCategory, deprecated: false }];
	const active = [];
	const deprecated = new Set();

	while (queue.length) {
		const { title: catTitle, deprecated: isDep } = queue.shift();
		if (visitedCats.has(catTitle)) {
			continue;
		}
		visitedCats.add(catTitle);

		for await (const data of paginate(api, {
			list: 'categorymembers',
			cmtitle: catTitle,
			cmtype: 'page|subcat',
			cmnamespace: '10|14|828',
			cmlimit: 'max',
		})) {
			for (const item of data?.query?.categorymembers || []) {
				if (item.ns === 14) {
					queue.push({
						title: item.title,
						deprecated: isDep || item.title.includes('已停用'),
					});
				} else if (item.ns === 10 || item.ns === 828) {
					if (isDep) {
						deprecated.add(item.title);
					} else {
						active.push({ title: item.title, ns: item.ns });
					}
				}
			}
		}
	}

	return { active, deprecated };
}

/**
 * Fetch prefix pages matching `<nsPrefix>CGroup/`.
 *
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {number} ns
 * @returns {Promise<Array<{ title: string, ns: number }>>}
 */
async function fetchCGroupPrefix(api, ns) {
	const pages = [];
	for await (const data of paginate(api, {
		list: 'allpages',
		apprefix: 'CGroup/',
		apnamespace: String(ns),
		aplimit: 'max',
	})) {
		for (const item of data?.query?.allpages || []) {
			if (/^(?:Module|Template):CGroup\/[^/]+$/i.test(item.title)) {
				pages.push({ title: item.title, ns: item.ns });
			}
		}
	}
	return pages;
}

/**
 * Fetch `MediaWiki:Conversiontable/*` (namespace 8) system conversion pages.
 *
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @returns {Promise<Array<{ title: string, ns: number }>>}
 */
async function fetchSystemConversionPages(api) {
	const pages = [];
	for await (const data of paginate(api, {
		list: 'allpages',
		apprefix: 'Conversiontable/',
		apnamespace: '8',
		aplimit: 'max',
	})) {
		for (const item of data?.query?.allpages || []) {
			if (item.title) {
				pages.push({ title: item.title, ns: 8 });
			}
		}
	}
	return pages;
}

/**
 * Use MediaWiki `action=parse` across zh variants to build simplified/traditional
 * alias mappings for all canonical CGroup names.
 *
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {string[]} groupNames
 * @returns {Promise<Record<string, string>>}
 */
async function buildConversionAliases(api, groupNames) {
	const aliases = Object.create(null);
	for (const groupName of groupNames) {
		const norm = normalizeGroupName(groupName);
		if (norm && !(norm in aliases)) {
			aliases[norm] = groupName;
		}
	}

	if (!groupNames.length) {
		return aliases;
	}

	const variants = ['zh-hans', 'zh-hant', 'zh-cn', 'zh-tw', 'zh-hk'];
	const chunkSize = 100;
	for (let i = 0; i < groupNames.length; i += chunkSize) {
		const chunk = groupNames.slice(i, i + chunkSize);
		const text = chunk.map((name, idx) => `<div data-idx="${idx}">${name}</div>`).join('\n');
		for (const variant of variants) {
			try {
				const { data } = await api.post({
					action: 'parse',
					text,
					contentmodel: 'wikitext',
					prop: 'text',
					uselang: variant,
					variant,
				}, { retry: 10 });
				const html = data?.parse?.text?.['*'] || data?.parse?.text || '';
				if (typeof html !== 'string') {
					continue;
				}
				const $ = loadHtml(html);
				$('[data-idx]').each((_, el) => {
					const idx = Number.parseInt($(el).attr('data-idx') || '', 10);
					const converted = $(el).text().trim();
					const canonical = chunk[idx];
					if (canonical && converted) {
						if (!(converted in aliases)) {
							aliases[converted] = canonical;
						}
						const norm = normalizeGroupName(converted);
						if (norm && !(norm in aliases)) {
							aliases[norm] = canonical;
						}
					}
				});
			} catch (err) {
				console.warn(`Failed to generate aliases for variant ${variant}:`, err?.message || err);
			}
		}
	}

	return aliases;
}

/**
 * Publish a conversion report page with standard header and timestamp.
 *
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {string} title
 * @param {string} reportWikitext
 * @param {string} introduction
 * @param {string} summary
 */
async function updateReport(api, title, reportWikitext, introduction, summary) {
	const text = `__NOCONTENTCONVERT__
${introduction}
* 本页面会定期更新，毋须手动修正。
* 生成时间：<onlyinclude>~~~~~</onlyinclude>

${reportWikitext}

[[Category:萌娘百科数据报告]]`;

	await api.postWithToken('csrf', {
		action: 'edit',
		title,
		text,
		summary,
		bot: true,
		nocreate: true,
		tags: TAGS,
		watchlist: 'nochange',
	}, {
		retry: 50,
		noCache: true,
	}).then(({ data }) => console.log(JSON.stringify(data)));
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	const api = await createAndLogin('zh', 'ibot');

	// 1. Collect CGroup pages (Module:CGroup/* + Template:CGroup/* + Category tree + MediaWiki:Conversiontable/*)
	const [{ active, deprecated }, modPrefix, tplPrefix, sysPages] = await Promise.all([
		collectCategoryTree(api, MAIN_CATEGORY),
		fetchCGroupPrefix(api, 828),
		fetchCGroupPrefix(api, 10),
		fetchSystemConversionPages(api),
	]);

	const groupPageMap = new Map();
	const registerCandidate = (page) => {
		if (deprecated.has(page.title)) {
			return;
		}
		const groupName = getGroupNameFromTitle(page.title);
		if (!groupName || groupName === 'core') {
			return;
		}
		const existing = groupPageMap.get(groupName);
		// Module (828) takes precedence over Template (10)
		if (!existing || page.ns === 828 && existing.ns !== 828) {
			groupPageMap.set(groupName, page);
		}
	};

	for (const p of [...active, ...modPrefix, ...tplPrefix]) {
		registerCandidate(p);
	}

	const cgroupPages = [...groupPageMap.values()];
	const allConversionPages = [...cgroupPages, ...sysPages];
	console.log(`Discovered ${cgroupPages.length} CGroup pages and ${sysPages.length} system conversion pages.`);

	// 2. Fetch and parse all conversion pages
	const conversionOfPage = Object.create(null);
	const rawGroupData = Object.create(null);
	const ruleOwners = new Map();

	await mapLimit(allConversionPages, 5, async ({ title, ns }) => {
		const { data } = await api.post({
			prop: 'revisions',
			titles: title,
			rvprop: 'content',
		}, { retry: 15 });
		const content = Object.values(data?.query?.pages || {})[0]?.revisions?.[0]?.content;
		const groupName = getGroupNameFromTitle(title);

		if (!content) {
			conversionOfPage[title] = { rules: [], transclusions: [], redirectTo: null, error: '无法读取页面内容' };
			return;
		}

		const parsed = ns === 828 ? parseLuaCGroup(content) : parseWikitextCGroup(content);
		conversionOfPage[title] = parsed;
		if (ns !== 8) {
			rawGroupData[groupName] = { ...parsed, pageTitle: title };
		}

		for (const rule of parsed.rules) {
			let owners = ruleOwners.get(rule);
			if (!owners) {
				owners = new Set();
				ruleOwners.set(rule, owners);
			}
			owners.add(title);
		}
	});

	// 3. Resolve multi-hop redirects and transclusions among CGroups
	const groupRules = Object.create(null);
	const redirectAliases = Object.create(null);
	const resolveGroupTarget = (groupName) => {
		let curr = groupName;
		const seen = new Set();
		for (let hop = 0; hop < 5 && rawGroupData[curr]?.redirectTo; hop++) {
			if (seen.has(curr)) {
				break;
			}
			seen.add(curr);
			curr = getGroupNameFromTitle(rawGroupData[curr].redirectTo);
		}
		return curr;
	};

	for (const groupName of Object.keys(rawGroupData)) {
		const canonical = resolveGroupTarget(groupName);
		const info = rawGroupData[canonical] || rawGroupData[groupName];
		if (canonical !== groupName && canonical in rawGroupData) {
			redirectAliases[groupName] = canonical;
		}
		const merged = new Set(info.rules);
		for (const inc of info.transclusions) {
			const incCanonical = resolveGroupTarget(inc);
			for (const r of rawGroupData[incCanonical]?.rules || []) {
				merged.add(r);
			}
		}
		groupRules[groupName] = [...merged];
	}

	// Build alias table (normalized group name + simplified/traditional variants + redirects)
	const groupAlias = await buildConversionAliases(api, Object.keys(groupRules));
	for (const [oldGroup, targetGroup] of Object.entries(redirectAliases)) {
		groupAlias[oldGroup] = targetGroup;
		const normOld = normalizeGroupName(oldGroup);
		if (normOld) {
			groupAlias[normOld] = targetGroup;
		}
	}

	// 4. Write report 1: conversion_list_page
	const listRows = Object.entries(conversionOfPage)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([title, info]) => {
			const count = info.rules.length;
			const statusPrefix = info.error
				? `<span style="color:red">'''${info.error}'''</span>`
				: info.redirectTo
					? `Redirect to → [[${info.redirectTo}]]${count > 0 ? '\n\n' : ''}`
					: info.transclusions.length
						? `嵌入转换组 ${info.transclusions.join(', ')} `
						: '';
			const detail = count > MAX_VOCAB_LIST
				? '<span style="color:#F61">\'\'\'字词过多，割爱\'\'\'</span>'
				: info.rules.join(' ');
			return `|-\n| [[${title}]] || ${count || ''} || data-sort-value="${count}"|${statusPrefix}${detail}`;
		});
	const overLimitCount = Object.values(conversionOfPage).filter((i) => i.rules.length > MAX_VOCAB_LIST).length;
	const listTable = `{| class="wikitable sortable"\n|-\n! 公共转换组页面 !! # !! 定义的词汇\n${listRows.join('\n')}\n|}`;
	await updateReport(
		api,
		CONVERSION_LIST_PAGE,
		listTable,
		`总计 ${listRows.length} 个公共转换组页面。${overLimitCount > 0 ? `其中 ${overLimitCount} 个公共转换组字词过多，割爱。` : ''}`,
		`${listRows.length}个公共转换组页面`,
	);

	// 5. Write report 2: duplicated_report_page
	const dupRows = [];
	for (const [rule, owners] of ruleOwners) {
		if (owners.size > 1) {
			const pagesList = [...owners].sort().map((p) => `[[${p}]]`);
			dupRows.push([rule, `|-\n| ${rule} || data-sort-value="${pagesList.length}"|${pagesList.length}: ${pagesList.join(', ')}`]);
		}
	}
	dupRows.sort(([a], [b]) => a.localeCompare(b));
	const dupWikitext = dupRows.length
		? `{| class="wikitable sortable"\n|-\n! 重复出现的词汇 !! 定义于公共转换组页面\n${dupRows.map(([, row]) => row).join('\n')}\n|}`
		: "* '''太好了！无重复词汇。'''";
	await updateReport(
		api,
		DUPLICATED_REPORT_PAGE,
		dupWikitext,
		`出现在多个不同公共转换组中的词汇：总计 ${dupRows.length} 个词汇。`,
		`${dupRows.length}个重复词汇`,
	);

	// 6. Track talk pages currently transcluding {{Invalid CGroup}}
	const invalidTalkPages = new Set();
	for await (const data of paginate(api, {
		list: 'embeddedin',
		eititle: UNREGISTERED_TEMPLATE,
		eilimit: 'max',
	})) {
		for (const item of data?.query?.embeddedin || []) {
			if (item.title && Parser.normalizeTitle(item.title).isTalkPage()) {
				invalidTalkPages.add(Parser.normalizeTitle(item.title).title);
			}
		}
	}

	// 7. Process articles embedding Template:NoteTA
	const noteTAPages = [];
	for await (const data of paginate(api, {
		list: 'embeddedin',
		eititle: 'Template:NoteTA',
		einamespace: '0',
		eilimit: 'max',
	})) {
		for (const item of data?.query?.embeddedin || []) {
			if (item.title) {
				noteTAPages.push(item.title);
			}
		}
	}
	console.log(`Found ${noteTAPages.length} NoteTA article(s), filtering by touched >= 14 days...`);

	const cutoffMs = Date.now() - TOUCHED_LOOKBACK_MS;
	const activeNoteTAPages = [];
	const infoBatches = splitAndJoin(noteTAPages, 500);
	await mapLimit(infoBatches, 3, async (titlesBatch) => {
		try {
			const { data } = await postWithBackoff(api, {
				prop: 'info',
				titles: titlesBatch,
			});
			for (const page of Object.values(data?.query?.pages || {})) {
				if (!page?.title || page.missing) {
					continue;
				}
				const talkTitle = Parser.normalizeTitle(page.title).toTalkPage().title;
				const touchedMs = page.touched ? Date.parse(page.touched) : 0;
				if (touchedMs >= cutoffMs || invalidTalkPages.has(talkTitle)) {
					activeNoteTAPages.push(page.title);
				}
			}
		} catch (err) {
			console.warn('Error fetching info batch:', err?.message || err);
		}
	});

	console.log(`Checking ${activeNoteTAPages.length} recently touched NoteTA article(s) in batches of 200...`);

	const titleBatches = splitAndJoin(activeNoteTAPages, 200);
	await mapLimit(titleBatches, 3, async (titlesBatch) => {
		try {
			const { data } = await postWithBackoff(api, {
				prop: 'revisions',
				titles: titlesBatch,
				rvprop: 'content',
			});
			const pages = Object.values(data?.query?.pages || {});

			await mapLimit(pages, 5, async (page) => {
				const pageTitle = page.title;
				const content = page?.revisions?.[0]?.content;
				if (!pageTitle || !content || NOBOTS_REGEX.test(content.replace(/\s+/g, ''))) {
					return;
				}

				const result = processNoteTAArticle(content, { groupRules, groupAlias });
				if (result.changed) {
					await api.postWithToken('csrf', {
						action: 'edit',
						title: pageTitle,
						text: result.content,
						summary: result.summaryParts.join('；'),
						bot: true,
						minor: true,
						nocreate: true,
						tags: TAGS,
						watchlist: 'nochange',
					}, {
						retry: 25,
						noCache: true,
					}).then(({ data: editRes }) => console.log(JSON.stringify(editRes)));
				}

				const talkTitle = Parser.normalizeTitle(pageTitle).toTalkPage().title;
				if (!result.unregisteredGroups.length && !invalidTalkPages.has(talkTitle)) {
					return;
				}

				const { data: talkData } = await api.post({
					prop: 'revisions',
					titles: talkTitle,
					rvprop: 'content',
				}, { retry: 15 });
				const talkContent = Object.values(talkData?.query?.pages || {})[0]?.revisions?.[0]?.content || '';
				if (!talkContent && !result.unregisteredGroups.length) {
					return;
				}

				const talkRes = updateInvalidCGroupTalkPage(talkContent, result.unregisteredGroups);
				if (!talkRes.changed) {
					return;
				}

				await api.postWithToken('csrf', {
					action: 'edit',
					title: talkTitle,
					text: talkRes.content,
					summary: talkRes.removed
						? `移除${UNREGISTERED_TEMPLATE}`
						: `标记未登记的公共转换组：${result.unregisteredGroups.join('、')}`,
					bot: true,
					minor: true,
					tags: TAGS,
					watchlist: 'nochange',
				}, {
					retry: 25,
					noCache: true,
				}).then(({ data: editRes }) => console.log(JSON.stringify(editRes)));
			});
		} catch (err) {
			console.error('Error processing NoteTA batch:', err?.message || err);
		}
	});

	console.log(`End time: ${new Date().toISOString()}`);
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
