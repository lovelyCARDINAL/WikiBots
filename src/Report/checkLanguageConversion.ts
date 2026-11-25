import process from 'process';
import type { MediaWikiApi, MwApiParams } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import mapLimit from '../utils/common/concurrency.ts';
import splitAndJoin from '../utils/common/splitAndJoin.ts';
import {
	buildConversionAliases,
	collectCategoryTree,
	fetchCGroupPrefix,
	fetchSystemConversionPages,
	parseAllConversionPages,
	resolveGroupRules,
	type ConversionPageMeta,
	type QueryPage,
} from '../utils/conversion/collect.ts';
import {
	normalizeGroupName,
	getGroupNameFromTitle,
	processNoteTAArticle,
	updateInvalidCGroupTalkPage,
} from '../utils/conversion/index.ts';
import { createAndLogin } from '../utils/core/createApi.ts';
import paginate from '../utils/core/paginate.ts';
import { withRetry } from '../utils/core/retry.ts';

Parser.config = 'moegirl';

const MAIN_CATEGORY = 'Category:公共转换组模块';
const CONVERSION_LIST_PAGE = '萌娘百科:字词转换处理报告/各页面包含字词';
const DUPLICATED_REPORT_PAGE = '萌娘百科:字词转换处理报告/重复字词报告';
const UNREGISTERED_TEMPLATE = 'Template:Invalid CGroup';
const TAGS = 'Bot';
const MAX_VOCAB_LIST = 500;
const TOUCHED_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const NOBOTS_REGEX = /\{\{(?:[Nn]obots|[Bb]ots\|(?:allow=none|deny=[^}]*(?:星海-interfacebot|all)))\}\}/;

function editWithRetry(api: MediaWikiApi, params: MwApiParams) {
	return withRetry(async () => {
		const res = await api.postWithToken<{ edit?: { result?: string } }>('csrf', params, { retry: 25, noCache: true });
		if (res?.data?.edit?.result && res.data.edit.result !== 'Success') {
			throw new Error(`Edit failed: ${JSON.stringify(res.data)}`);
		}
		return res;
	}, 25, 'api.postWithToken(edit)');
}

async function updateReport(
	api: MediaWikiApi,
	title: string,
	reportWikitext: string,
	introduction: string,
	summary: string,
): Promise<void> {
	const text = `__NOCONTENTCONVERT__
* 本页面为[[U:星海-interfacebot|机器人]]生成的${introduction}
* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}

-{
${reportWikitext}
}-

[[Category:萌娘百科数据报告]]`;

	await editWithRetry(api, {
		action: 'edit',
		title,
		text,
		summary,
		bot: true,
		nocreate: true,
		tags: TAGS,
		watchlist: 'nochange',
	}).then(({ data }) => console.log(JSON.stringify(data)));
}

async function processSingleNoteTAPage(
	api: MediaWikiApi,
	page: QueryPage,
	groupRules: Record<string, string[]>,
	groupAlias: Record<string, string>,
	invalidTalkPages: Set<string>,
): Promise<void> {
	const pageTitle = page.title;
	const content = page?.revisions?.[0]?.content;
	if (!pageTitle || !content || NOBOTS_REGEX.test(content.replace(/\s+/g, ''))) {
		return;
	}

	const result = processNoteTAArticle(content, { groupRules, groupAlias });
	if (result.changed) {
		await editWithRetry(api, {
			action: 'edit',
			title: pageTitle,
			text: result.content,
			summary: result.summaryParts.join('；'),
			bot: true,
			minor: true,
			nocreate: true,
			tags: TAGS,
			watchlist: 'nochange',
		}).then(({ data: editRes }) => console.log(JSON.stringify(editRes)));
	}

	const talkTitle = Parser.normalizeTitle(pageTitle).toTalkPage().title;
	if (!result.unregisteredGroups.length && !invalidTalkPages.has(talkTitle)) {
		return;
	}

	const { data: talkData } = await withRetry(() => api.post<{
		query?: { pages?: Record<string, QueryPage> };
	}>({
		prop: 'revisions',
		titles: talkTitle,
		rvprop: 'content',
	}, { retry: 25 }), 25, 'api.post(revisions)');
	const talkContent = Object.values(talkData?.query?.pages || {})[0]?.revisions?.[0]?.content || '';
	if (!talkContent && !result.unregisteredGroups.length) {
		return;
	}

	const talkRes = updateInvalidCGroupTalkPage(talkContent, result.unregisteredGroups);
	if (!talkRes.changed) {
		return;
	}

	await editWithRetry(api, {
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
	}).then(({ data: editRes }) => console.log(JSON.stringify(editRes)));
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	const api = await createAndLogin('zh', 'ibot');

	const [{ active, deprecated }, modPrefix, tplPrefix, sysPages] = await Promise.all([
		collectCategoryTree(api, MAIN_CATEGORY),
		fetchCGroupPrefix(api, 828),
		fetchCGroupPrefix(api, 10),
		fetchSystemConversionPages(api),
	]);

	const IGNORED_GROUPS = new Set(['core', 'sandbox']);
	const groupPageMap = new Map<string, ConversionPageMeta>();
	for (const page of [...active, ...modPrefix, ...tplPrefix]) {
		if (deprecated.has(page.title)) {
			continue;
		}
		const groupName = getGroupNameFromTitle(page.title);
		if (!groupName || IGNORED_GROUPS.has(groupName.toLowerCase())) {
			continue;
		}
		const existing = groupPageMap.get(groupName);
		if (!existing || page.ns === 828 && existing.ns !== 828) {
			groupPageMap.set(groupName, page);
		}
	}

	const cgroupPages = [...groupPageMap.values()];
	const allConversionPages = [...cgroupPages, ...sysPages];
	console.log(`Discovered ${cgroupPages.length} CGroup pages and ${sysPages.length} system conversion pages.`);

	const { conversionOfPage, rawGroupData, vocabOwners } = await parseAllConversionPages(api, allConversionPages);
	const { groupRules, redirectAliases } = resolveGroupRules(rawGroupData);
	const groupAlias = await buildConversionAliases(api, Object.keys(groupRules));
	for (const [oldGroup, targetGroup] of Object.entries(redirectAliases)) {
		groupAlias[oldGroup] = targetGroup;
		const normOld = normalizeGroupName(oldGroup);
		if (normOld) {
			groupAlias[normOld] = targetGroup;
		}
	}

	const listRows = Object.entries(conversionOfPage)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([title, info]) => {
			const count = info.vocabularies.length;
			const statusPrefix = info.error
				? `<span style="color:red">'''${info.error}'''</span>`
				: info.redirectTo
					? `Redirect to → [[${info.redirectTo}]]${count > 0 ? '\n\n' : ''}`
					: info.transclusions.length
						? `嵌入转换组 ${info.transclusions.join(', ')} `
						: '';
			const detail = count > MAX_VOCAB_LIST
				? '<span style="color:#F61">\'\'\'字词过多，割爱\'\'\'</span>'
				: info.vocabularies.join('; ');
			return `|-\n| [[${title}]] || ${count || !info.error && !info.redirectTo ? count : ''} || data-sort-value="${count}"|${statusPrefix}${detail}`;
		});
	const overLimitCount = Object.values(conversionOfPage).filter((i) => i.vocabularies.length > MAX_VOCAB_LIST).length;
	await updateReport(
		api,
		CONVERSION_LIST_PAGE,
		`{| class="wikitable sortable"\n|-\n! 公共转换组页面 !! # !! 定义的词汇\n${listRows.join('\n')}\n|}`,
		`公共转换组各页面包含字词：总计 ${listRows.length} 个公共转换组页面。${overLimitCount > 0 ? `其中 ${overLimitCount} 个公共转换组字词过多，割爱。` : ''}`,
		`${listRows.length}个公共转换组页面`,
	);

	const dupRows: Array<[string, string]> = [];
	for (const [vocab, owners] of vocabOwners) {
		if (owners.size > 1) {
			const pagesList = [...owners].sort().map((p) => `[[${p}]]`);
			dupRows.push([vocab, `|-\n| ${vocab} || data-sort-value="${pagesList.length}"|${pagesList.length}: ${pagesList.join(', ')}`]);
		}
	}
	dupRows.sort(([a], [b]) => a.localeCompare(b));
	await updateReport(
		api,
		DUPLICATED_REPORT_PAGE,
		dupRows.length
			? `{| class="wikitable sortable"\n|-\n! 重复出现的词汇 !! 定义于公共转换组页面\n${dupRows.map(([, row]) => row).join('\n')}\n|}`
			: "* '''太好了！无重复词汇。'''",
		`出现在多个不同公共转换组中的词汇：总计 ${dupRows.length} 个词汇。`,
		`${dupRows.length}个重复词汇`,
	);

	const invalidTalkPages = new Set<string>();
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

	const noteTAPages: string[] = [];
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
	const activeNoteTAPages: string[] = [];
	await mapLimit(splitAndJoin(noteTAPages, 500), 3, async (titlesBatch) => {
		try {
			const { data } = await withRetry(() => api.post<{
				query?: { pages?: Record<string, QueryPage> };
			}>({ prop: 'info', titles: titlesBatch }, { retry: 25 }), 25, 'api.post(info)');
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
			console.warn('Error fetching info batch:', err instanceof Error ? err.message : String(err));
			process.exitCode = 1;
		}
	});

	console.log(`Checking ${activeNoteTAPages.length} recently touched NoteTA article(s) in batches of 100...`);

	await mapLimit(splitAndJoin(activeNoteTAPages, 100), 2, async (titlesBatch) => {
		try {
			const { data } = await withRetry(() => api.post<{
				query?: { pages?: Record<string, QueryPage> };
			}>({ prop: 'revisions', titles: titlesBatch, rvprop: 'content' }, { retry: 25 }), 25, 'api.post(revisions)');
			await mapLimit(
				Object.values(data?.query?.pages || {}),
				5,
				(page) => processSingleNoteTAPage(api, page, groupRules, groupAlias, invalidTalkPages),
			);
		} catch (err) {
			console.error('Error processing NoteTA batch:', err instanceof Error ? err.message : String(err));
			process.exitCode = 1;
		}
	});

	console.log(`End time: ${new Date().toISOString()}`);
})().catch((err) => {
	console.error(err?.message || err);
	process.exit(1);
});
