import type { MediaWikiApi, MwApiParams } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import { withRetry } from '../core/retry.ts';
import type { ConversionEntry, QueryPage } from './collect.ts';
import { processNoteTAArticle, updateInvalidCGroupTalkPage } from './index.ts';

const TAGS = 'Bot';
const MAX_VOCAB_LIST = 500;
const UNREGISTERED_TEMPLATE = 'Template:Invalid CGroup';
const NOBOTS_REGEX = /\{\{(?:[Nn]obots|[Bb]ots\|(?:allow=none|deny=[^}]*(?:星海-interfacebot|all)))\}\}/;

export function editWithRetry(api: MediaWikiApi, params: MwApiParams) {
	return withRetry(async () => {
		const res = await api.postWithToken<{ edit?: { result?: string } }>('csrf', params, { retry: 25, noCache: true });
		if (res?.data?.edit?.result && res.data.edit.result !== 'Success') {
			throw new Error(`Edit failed: ${JSON.stringify(res.data)}`);
		}
		return res;
	}, 25, 'api.postWithToken(edit)');
}

export async function updateConversionReport(
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

export function buildConversionListReport(conversionOfPage: Record<string, ConversionEntry>): {
	wikitext: string;
	introduction: string;
	summary: string;
} {
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
	return {
		wikitext: `{| class="wikitable sortable"\n|-\n! 公共转换组页面 !! # !! 定义的词汇\n${listRows.join('\n')}\n|}`,
		introduction: `公共转换组各页面包含字词：总计 ${listRows.length} 个公共转换组页面。${overLimitCount > 0 ? `其中 ${overLimitCount} 个公共转换组字词过多，割爱。` : ''}`,
		summary: `${listRows.length}个公共转换组页面`,
	};
}

export function buildDuplicatedVocabReport(vocabOwners: Map<string, Set<string>>): {
	wikitext: string;
	introduction: string;
	summary: string;
} {
	const dupRows: Array<[string, string]> = [];
	for (const [vocab, owners] of vocabOwners) {
		if (owners.size > 1) {
			const pagesList = [...owners].sort().map((p) => `[[${p}]]`);
			dupRows.push([vocab, `|-\n| ${vocab} || data-sort-value="${pagesList.length}"|${pagesList.length}: ${pagesList.join(', ')}`]);
		}
	}
	dupRows.sort(([a], [b]) => a.localeCompare(b));
	return {
		wikitext: dupRows.length
			? `{| class="wikitable sortable"\n|-\n! 重复出现的词汇 !! 定义于公共转换组页面\n${dupRows.map(([, row]) => row).join('\n')}\n|}`
			: "* '''太好了！无重复词汇。'''",
		introduction: `出现在多个不同公共转换组中的词汇：总计 ${dupRows.length} 个词汇。`,
		summary: `${dupRows.length}个重复词汇`,
	};
}

export async function processSingleNoteTAPage(
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
	}>({ prop: 'revisions', titles: talkTitle, rvprop: 'content' }, { retry: 25 }), 25, 'api.post(revisions)');
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
