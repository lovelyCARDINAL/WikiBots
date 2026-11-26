import moment from 'moment';
import type { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import type { MwAllUser, MwQueryResponse, MwRedirectItem } from '../types/mediawiki.d.ts';
import { createAndLogin } from '../utils/core/createApi.ts';
import parserConfig from '../utils/core/parserConfig.ts';
import {
	applyRedirectEdits,
	fetchPaginatedPages,
	updateCmTemplates,
	updatePageCategories,
	updateZhTemplates,
} from '../utils/wiki/redirectFix.ts';

Parser.config = 'moegirl';
Parser.conversionTable = new Map(parserConfig.conversionTable);

const SITE_LIST = ['zh', 'cm'] as const;

interface RedirectCategoryPage {
	pageid: number;
	title: string;
	categoryinfo: { size: number };
	revisions: Array<{ user: string; timestamp: string }>;
	varianttitles: Record<string, string>;
}

interface MemberPage {
	pageid: number;
	revisions: Array<{ content: string }>;
}

async function processCategoryRedirect(
	api: MediaWikiApi,
	site: typeof SITE_LIST[number],
	{ title, varianttitles }: RedirectCategoryPage,
	redirects: MwRedirectItem[] | undefined,
	contentData: Record<number, { content?: string; summary?: string }>,
): Promise<void> {
	try {
		const target = redirects?.find(({ from }) => from === title)?.to.replace('Category:', '');
		if (!target) {
			console.warn(`${site} ${title}：找不到重定向目标`);
			return;
		}

		const variant = new Set<string>(
			Object.values(varianttitles).map((item) => item.replace(/Category:|分类:|分類:/, '')),
		);
		const variantList = [...variant, ...Array.from(variant).map((item) => item.replaceAll(' ', '_'))];

		const members = await fetchPaginatedPages<MemberPage>(api, {
			prop: 'revisions',
			generator: 'categorymembers',
			rvprop: 'content',
			gcmtitle: title,
			gcmlimit: '500',
		});

		for (const { pageid, revisions } of members) {
			const content = revisions?.[0]?.content;
			if (content === undefined) {
				continue;
			}
			const wikitext = Parser.parse(contentData[pageid]?.content || content);
			updatePageCategories(wikitext, target, variant);
			if (site === 'zh') {
				updateZhTemplates(wikitext, target, variantList);
			} else {
				updateCmTemplates(wikitext, target, variantList);
			}

			contentData[pageid] ||= {};
			contentData[pageid].content = wikitext.toString();
			const linkDiff = `[[${title.replace('Category:', 'Cat:')}]] → [[Cat:${target}]]`;
			contentData[pageid].summary = contentData[pageid].summary
				? `${contentData[pageid].summary}，${linkDiff}`
				: `修复分类重定向：${linkDiff}`;
			console.log(`${site} ${pageid}: ${title} → ${target}`);
		}
	} catch (error) {
		console.error(`${site} ${title} 处理失败:`, error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

async function processSite(
	site: typeof SITE_LIST[number],
	zhapi: MediaWikiApi,
	userlist: string[],
): Promise<void> {
	const api: MediaWikiApi = site === 'zh' ? zhapi : await createAndLogin(site, 'bot', 75);

	let pages = await fetchPaginatedPages<RedirectCategoryPage>(api, {
		prop: 'categoryinfo|info|revisions',
		generator: 'categorymembers',
		cllimit: 'max',
		inprop: 'varianttitles',
		rvprop: 'timestamp|user',
		gcmtitle: 'Category:已重定向的分类',
		gcmprop: 'ids|title',
		gcmtype: 'subcat',
		gcmlimit: 'max',
	});

	pages = pages.filter(({ categoryinfo }) => (categoryinfo?.size ?? 0) > 0);
	console.info(`${site}: ${pages.length}个已重定向分类尚未清空`);
	if (!pages.length) {
		console.log(`${site}: 没有需要修复的已重定向分类`);
		return;
	}

	pages = pages.filter(({ revisions }) => {
		const rev = revisions?.[0];
		return rev ? userlist.includes(rev.user) || moment(rev.timestamp).isBefore(moment().subtract(3, 'days')) : false;
	});
	console.info(`${site}: ${pages.length}个已重定向分类符合自动修复条件`);
	if (!pages.length) {
		return;
	}

	const { data: redirectRes } = await api.post<MwQueryResponse<{ redirects?: MwRedirectItem[] }>>({
		redirects: true,
		pageids: pages.map(({ pageid }) => String(pageid)),
	}, { retry: 50 });
	const redirects = redirectRes?.query?.redirects;

	const contentData: Record<number, { content?: string; summary?: string }> = {};
	await Promise.all(pages.map((page) => processCategoryRedirect(api, site, page, redirects, contentData)));
	await applyRedirectEdits(api, site, contentData);
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	const zhapi = await createAndLogin('zh', 'bot', 75);

	const { data } = await zhapi.post<MwQueryResponse<{ allusers?: MwAllUser[] }>>({
		list: 'allusers',
		augroup: ['sysop', 'bot', 'patroller', 'honoredmaintainer', 'goodeditor', 'extendedconfirmed', 'staff'],
		aulimit: 'max',
	}, { retry: 50 });
	const userlist = (data?.query?.allusers ?? []).map(({ name }) => name);
	console.info(`共${userlist.length}个延确或优编及以上用户`);

	await Promise.all(SITE_LIST.map(async (site) => {
		try {
			await processSite(site, zhapi, userlist);
		} catch (error) {
			console.error(`${site} 执行失败:`, error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();
