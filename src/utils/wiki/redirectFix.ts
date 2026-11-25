import type { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import paginate from '../core/paginate.ts';

function removeCategory(category: Parser.CategoryToken): void {
	const prev = category.previousSibling;
	const next = category.nextSibling;
	const atLineStart = !prev || prev.type === 'text' && /\n$/.test(prev.data);
	if (atLineStart && next?.type === 'text' && next.data.startsWith('\n')) {
		next.replaceData(next.data.slice(1));
	}
	category.remove();
}

export async function fetchPaginatedPages<T>(api: MediaWikiApi, params: Record<string, string>): Promise<T[]> {
	const result: T[] = [];
	for await (const data of paginate<{ query?: { pages?: Record<string, T> } }>(api, params, { retry: 50 })) {
		if (data?.query?.pages) {
			result.push(...Object.values(data.query.pages));
		}
	}
	return result;
}

export function updatePageCategories(wikitext: Parser.Token, target: string, variant: Set<string>): void {
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

export function updateZhTemplates(wikitext: Parser.Token, target: string, variantList: string[]): void {
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

export function updateCmTemplates(wikitext: Parser.Token, target: string, variantList: string[]): void {
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

export async function applyRedirectEdits(
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
			}, { retry: 50, noCache: true });
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
