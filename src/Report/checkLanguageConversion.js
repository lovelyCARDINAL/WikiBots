import process from 'process';
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

Parser.config = 'moegirl';

const MAIN_CATEGORY = 'Category:公共转换组模块';
const CONVERSION_LIST_PAGE = '萌娘百科:字词转换处理报告/各页面包含字词';
const DUPLICATED_REPORT_PAGE = '萌娘百科:字词转换处理报告/重复字词报告';
const UNREGISTERED_TEMPLATE = 'Template:Invalid CGroup';
const TAGS = 'Bot';
const MAX_VOCAB_LIST = 500;
const NOBOTS_REGEX = /\{\{(?:[Nn]obots|[Bb]ots\|(?:allow=none|deny=[^}]*(?:星海-interfacebot|all)))\}\}/;

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

	// 1. Collect CGroup pages (Module:CGroup/* + Template:CGroup/* + Category tree)
	const [{ active, deprecated }, modPrefix, tplPrefix] = await Promise.all([
		collectCategoryTree(api, MAIN_CATEGORY),
		fetchCGroupPrefix(api, 828),
		fetchCGroupPrefix(api, 10),
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
	console.log(`Discovered ${cgroupPages.length} CGroup pages.`);

	// 2. Fetch and parse all CGroup pages
	const conversionOfPage = Object.create(null);
	const rawGroupData = Object.create(null);
	const ruleOwners = new Map();

	await mapLimit(cgroupPages, 5, async ({ title, ns }) => {
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
		rawGroupData[groupName] = { ...parsed, pageTitle: title };

		for (const rule of parsed.rules) {
			let owners = ruleOwners.get(rule);
			if (!owners) {
				owners = new Set();
				ruleOwners.set(rule, owners);
			}
			owners.add(title);
		}
	});

	// 3. Resolve transclusions and redirects among CGroups
	const groupRules = Object.create(null);
	for (const [groupName, info] of Object.entries(rawGroupData)) {
		if (info.redirectTo) {
			const targetGroup = getGroupNameFromTitle(info.redirectTo);
			if (rawGroupData[targetGroup]) {
				groupRules[groupName] = [...rawGroupData[targetGroup].rules];
				continue;
			}
		}
		const merged = new Set(info.rules);
		for (const inc of info.transclusions) {
			for (const r of rawGroupData[inc]?.rules || []) {
				merged.add(r);
			}
		}
		groupRules[groupName] = [...merged];
	}

	// Build alias table (normalized group name + redirect titles)
	const groupAlias = Object.create(null);
	for (const groupName of Object.keys(groupRules)) {
		const norm = normalizeGroupName(groupName);
		if (norm && !(norm in groupAlias)) {
			groupAlias[norm] = groupName;
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
	console.log(`Checking ${noteTAPages.length} NoteTA article(s)...`);

	await mapLimit(noteTAPages, 5, async (pageTitle) => {
		try {
			const { data } = await api.post({
				prop: 'revisions',
				titles: pageTitle,
				rvprop: 'content',
			}, { retry: 15 });
			const content = Object.values(data?.query?.pages || {})[0]?.revisions?.[0]?.content;
			if (!content || NOBOTS_REGEX.test(content.replace(/\s+/g, ''))) {
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
		} catch (err) {
			console.error(`Error processing [[${pageTitle}]]:`, err?.message || err);
		}
	});

	console.log(`End time: ${new Date().toISOString()}`);
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
