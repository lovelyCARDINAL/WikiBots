import process from 'process';
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
import { getGroupNameFromTitle, normalizeGroupName } from '../utils/conversion/index.ts';
import {
	buildConversionListReport,
	buildDuplicatedVocabReport,
	processSingleNoteTAPage,
	updateConversionReport,
} from '../utils/conversion/report.ts';
import { createAndLogin } from '../utils/core/createApi.ts';
import paginate from '../utils/core/paginate.ts';
import { withRetry } from '../utils/core/retry.ts';

Parser.config = 'moegirl';

const MAIN_CATEGORY = 'Category:公共转换组模块';
const CONVERSION_LIST_PAGE = '萌娘百科:字词转换处理报告/各页面包含字词';
const DUPLICATED_REPORT_PAGE = '萌娘百科:字词转换处理报告/重复字词报告';
const UNREGISTERED_TEMPLATE = 'Template:Invalid CGroup';
const TOUCHED_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

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

	const listReport = buildConversionListReport(conversionOfPage);
	await updateConversionReport(api, CONVERSION_LIST_PAGE, listReport.wikitext, listReport.introduction, listReport.summary);

	const dupReport = buildDuplicatedVocabReport(vocabOwners);
	await updateConversionReport(api, DUPLICATED_REPORT_PAGE, dupReport.wikitext, dupReport.introduction, dupReport.summary);

	const invalidTalkPages = new Set<string>();
	for await (const data of paginate(api, { list: 'embeddedin', eititle: UNREGISTERED_TEMPLATE, eilimit: 'max' })) {
		for (const item of data?.query?.embeddedin || []) {
			if (item.title && Parser.normalizeTitle(item.title).isTalkPage()) {
				invalidTalkPages.add(Parser.normalizeTitle(item.title).title);
			}
		}
	}

	const noteTAPages: string[] = [];
	for await (const data of paginate(api, { list: 'embeddedin', eititle: 'Template:NoteTA', einamespace: '0', eilimit: 'max' })) {
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
