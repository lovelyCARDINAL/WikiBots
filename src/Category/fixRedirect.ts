import moment from 'moment';
import type { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import type { MwAllUser, MwQueryResponse, MwRedirectItem } from '../types/mediawiki.d.ts';
import { createAndLogin } from '../utils/core/createApi.ts';
import paginate from '../utils/core/paginate.ts';
import parserConfig from '../utils/core/parserConfig.ts';

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

/**
 * Remove a CategoryToken and collapse its trailing newline when it occupied its own line.
 */
function removeCategory(category: Parser.CategoryToken): void {
	const prev = category.previousSibling;
	const next = category.nextSibling;
	const atLineStart = !prev || prev.type === 'text' && /\n$/.test(prev.data);
	if (atLineStart && next?.type === 'text' && next.data.startsWith('\n')) {
		next.replaceData(next.data.slice(1));
	}
	category.remove();
}

async function fetchPaginatedPages<T>(api: MediaWikiApi, params: Record<string, string>): Promise<T[]> {
	const result: T[] = [];
	for await (const data of paginate<{ query?: { pages?: Record<string, T> } }>(api, params, { retry: 50 })) {
		if (data?.query?.pages) {
			result.push(...Object.values(data.query.pages));
		}
	}
	return result;
}

function updatePageCategories(wikitext: Parser.Token, target: string, variant: Set<string>): void {
	const targetName = Parser.normalizeTitle(`Category:${target}`).title;
	const variantNames = new Set(Array.from(variant, (item) => Parser.normalizeTitle(`Category:${item}`).title));
	const categories = wikitext.querySelectorAll<Parser.CategoryToken>('category');
	let targetCategory = categories.find((cat) => Parser.normalizeTitle(cat.name).title === targetName);
	for (const category of categories) {
		if (!variantNames.has(Parser.normalizeTitle(category.name).title)) {
			continue;
		}
		if (targetCategory) {
			if (!targetCategory.sortkey && category.sortkey) {
				targetCategory.setSortkey(category.sortkey);
			}
			removeCategory(category);
		} else {
			category.setTarget(`Category:${target}`);
			targetCategory = category;
		}
	}
}

const MOEDIAN_MODIFIERS = new Set(['del', '黑幕', 'heimu', '加粗', 'b']);

function rewriteMoePointArg(temp: Parser.TranscludeToken, arg: Parser.ParameterToken, target: string, variantList: string[]): void {
	const parts = arg.value.split(/[,，]/);
	const normalizeValue = Parser.normalizeTitle(parts[0].trim()).title;
	if (!variantList.includes(normalizeValue)) {
		return;
	}
	if (parts.length === 1) {
		temp.setValue(arg.name, `${target},${arg.value}`);
	} else if (parts.length === 2) {
		const second = parts[1];
		if (MOEDIAN_MODIFIERS.has(second.trim())) {
			temp.setValue(arg.name, `${target},${arg.value}`);
		} else {
			temp.setValue(arg.name, target === second ? target : `${target},${second}`);
		}
	} else if (parts.length === 3) {
		temp.setValue(arg.name, target === parts[1] ? `${target},${parts[2]}` : `${target},${parts[1]},${parts[2]}`);
	}
}

function updateZhTemplates(wikitext: Parser.Token, target: string, variantList: string[]): void {
	const param = wikitext.querySelector<Parser.ParameterToken>('parameter:regex("name, /^(?:声优|聲優|配音)$/")');
	if (param) {
		const value = param.value.trim();
		const newValue = target.replace('配音角色', '');
		if (variantList.includes(`${Parser.normalizeTitle(value).title}配音角色`)) {
			param.setValue(param.lastChild!.text().replace(value, newValue));
		}
	}

	for (const temp of wikitext.querySelectorAll<Parser.TranscludeToken>('template:regex(name, /^Template:萌[点點]$/)')) {
		for (const arg of temp.getAllArgs()) {
			rewriteMoePointArg(temp, arg, target, variantList);
		}
	}

	for (const temp of wikitext.querySelectorAll<Parser.TranscludeToken>('template#Template:Cate')) {
		for (const arg of temp.getAllArgs()) {
			const normalizeValue = Parser.normalizeTitle(arg.value.trim()).title;
			if (variantList.includes(normalizeValue) && arg.name !== '1') {
				temp.setValue(arg.name, target);
			}
		}
	}
}

function updateCmTemplates(wikitext: Parser.Token, target: string, variantList: string[]): void {
	const temp1 = wikitext.querySelector<Parser.TranscludeToken>('template:regex(name, /^Template:[虚虛][拟擬]角色\\/作$/)');
	if (temp1) {
		for (const arg of temp1.getAllArgs()) {
			if (variantList.includes(`${arg.value.trim()}角色`) && arg.name !== 'more') {
				temp1.setValue(arg.name, target.replace(/角色$/, ''));
			}
		}
	}

	const temp2 = wikitext.querySelector<Parser.TranscludeToken>('template#Template:作品');
	if (temp2) {
		for (const arg of temp2.getAllArgs()) {
			if (variantList.includes(arg.value.trim()) && arg.name !== '1') {
				temp2.setValue(arg.name, target);
			}
		}
	}
}

async function applyPageEdits(
	api: MediaWikiApi,
	site: string,
	contentData: Record<number, { content?: string; summary?: string }>,
): Promise<void> {
	await Promise.all(Object.entries(contentData).map(async ([pageid, { content: text, summary }]) => {
		try {
			const { data } = await api.postWithToken('csrf', {
				action: 'edit',
				pageid,
				text,
				summary,
				minor: true,
				bot: true,
				nocreate: true,
				tags: 'Bot',
				watchlist: 'nochange',
			}, {
				retry: 50,
				noCache: true,
			});
			console.log(JSON.stringify(data));
			if (data?.edit?.result && data.edit.result !== 'Success') {
				console.error(`${site} ${pageid} 编辑未成功:`, JSON.stringify(data));
				process.exitCode = 1;
			}
		} catch (error) {
			console.error(`${site} ${pageid} 编辑失败:`, error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	}));
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

	pages = pages.filter(({ categoryinfo: { size } }) => size > 0);
	console.info(`${site}: ${pages.length}个已重定向分类尚未清空`);
	if (pages.length === 0) {
		console.log(`${site}: 没有需要修复的已重定向分类`);
		return;
	}

	pages = pages.filter(({ revisions: [{ user, timestamp }] }) => userlist.includes(user) || moment(timestamp).isBefore(moment().subtract(3, 'days')));
	console.info(`${site}: ${pages.length}个已重定向分类符合自动修复条件`);
	if (pages.length === 0) {
		return;
	}

	const { data: { query: { redirects } } } = await api.post<MwQueryResponse<{ redirects?: MwRedirectItem[] }>>({
		redirects: true,
		pageids: pages.map(({ pageid }) => String(pageid)),
	}, {
		retry: 50,
	});

	const contentData: Record<number, { content?: string; summary?: string }> = {};
	await Promise.all(pages.map(async ({ title, varianttitles }) => {
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

			for (const { pageid, revisions: [{ content }] } of members) {
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
	}));

	await applyPageEdits(api, site, contentData);
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	const zhapi = await createAndLogin('zh', 'bot', 75);

	const { data: { query: { allusers } } } = await zhapi.post<MwQueryResponse<{ allusers: MwAllUser[] }>>({
		list: 'allusers',
		augroup: ['sysop', 'bot', 'patroller', 'honoredmaintainer', 'goodeditor', 'extendedconfirmed', 'staff'],
		aulimit: 'max',
	}, {
		retry: 50,
	});
	const userlist = allusers.map(({ name }) => name);
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
