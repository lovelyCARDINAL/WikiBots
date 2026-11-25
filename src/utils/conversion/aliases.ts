import { load as loadHtml } from 'cheerio';
import type { MediaWikiApi } from 'wiki-saikou';
import { withRetry } from '../core/retry.ts';
import { normalizeGroupName } from './index.ts';

function applyVariantHtmlAliases(html: string, chunk: string[], aliases: Record<string, string>): void {
	const $ = loadHtml(html);
	$('[data-idx]').each((_, el) => {
		const idx = Number.parseInt($(el).attr('data-idx') || '', 10);
		const converted = $(el).text().trim();
		const canonical = chunk[idx];
		if (!canonical || !converted) {
			return;
		}
		if (!(converted in aliases)) {
			aliases[converted] = canonical;
		}
		const norm = normalizeGroupName(converted);
		if (norm && !(norm in aliases)) {
			aliases[norm] = canonical;
		}
	});
}

async function fetchVariantAliasesForChunk(
	api: MediaWikiApi,
	chunk: string[],
	text: string,
	variant: string,
	aliases: Record<string, string>,
): Promise<void> {
	try {
		const { data } = await withRetry(() => api.post<{
			parse?: { text?: string | { '*'?: string } };
		}>({
			action: 'parse',
			text,
			contentmodel: 'wikitext',
			prop: 'text',
			uselang: variant,
			variant,
		}, { retry: 25 }), 25, 'api.post(parse)');
		const parseText = data?.parse?.text;
		const html = typeof parseText === 'string' ? parseText : parseText?.['*'] || '';
		if (typeof html === 'string') {
			applyVariantHtmlAliases(html, chunk, aliases);
		}
	} catch (err) {
		console.warn(`Failed to generate aliases for variant ${variant}:`, err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
	}
}

/**
 * Use MediaWiki `action=parse` across zh variants to build simplified/traditional
 * alias mappings for all canonical CGroup names.
 */
export async function buildConversionAliases(api: MediaWikiApi, groupNames: string[]): Promise<Record<string, string>> {
	const aliases = Object.create(null) as Record<string, string>;
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
	for (let i = 0; i < groupNames.length; i += 100) {
		const chunk = groupNames.slice(i, i + 100);
		const text = chunk.map((name, idx) => `<div data-idx="${idx}">${name}</div>`).join('\n');
		for (const variant of variants) {
			await fetchVariantAliasesForChunk(api, chunk, text, variant, aliases);
		}
	}

	return aliases;
}
