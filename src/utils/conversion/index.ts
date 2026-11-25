const LANG_CODE_RE = /^(?:zh|zh-(?:hans|hant|cn|tw|hk))$/i;

/**
 * Repeatedly strip all matches of `pattern` until the string stabilizes.
 *
 * @param {string} input
 * @param {RegExp} pattern
 * @returns {string}
 */
function stripPattern(input: string, pattern: RegExp): string {
	let result = input;
	let prev: string;
	do {
		prev = result;
		result = result.replace(pattern, '');
	} while (result !== prev);
	return result;
}

/**
 * Normalize a CGroup name for fuzzy/alias matching.
 *
 * @param {string} groupName
 * @returns {string}
 */
function normalizeGroupName(groupName: string): string {
	const cleaned = groupName
		.replace(/[\s_\-–()（）{}「」#＝]/g, '')
		.replace(/^CGroup\//i, '')
		.replace(/^=+/g, '');
	return stripPattern(cleaned, /<\/?\w[^<>]*>/g)
		.replace(/s?[;:.，[\]]*$/g, '')
		.trim()
		.toLowerCase();
}

/**
 * Extract the canonical CGroup name from a page title.
 *
 * @param {string} title
 * @returns {string}
 */
function getGroupNameFromTitle(title: string): string {
	const match = title.match(/^(?:Module|Template):CGroup\/(.+)$/i)
		|| title.match(/^MediaWiki:Conversiontable\/(.+)$/i);
	if (match) {
		return match[1].trim();
	}
	return title.replace(/^(?:[^:]+):/, '').trim();
}

/**
 * Parse a MediaWiki conversion rule string like `zh-hans:测试; zh-hant:測試;`
 * into a canonical sorted string `zh-hans:测试;zh-hant:測試;`, or `null` if invalid/empty.
 *
 * @param {string} rawRule
 * @returns {{ normalized: string, map: Record<string, string> } | null}
 */
function normalizeConversionRule(rawRule: string): { normalized: string; map: Record<string, string> } | null {
	if (!rawRule || typeof rawRule !== 'string') {
		return null;
	}
	const map = Object.create(null) as Record<string, string>;
	for (const part of rawRule.split(';')) {
		const idx = part.indexOf(':');
		if (idx <= 0) {
			continue;
		}
		const lang = part.slice(0, idx).trim().toLowerCase();
		const word = part.slice(idx + 1).trim();
		if (!LANG_CODE_RE.test(lang) || !word) {
			continue;
		}
		map[lang] = word;
	}
	const langs = Object.keys(map).sort();
	if (langs.length < 2) {
		return null;
	}
	const normalized = `${langs.map((l) => `${l}:${map[l]}`).join(';')};`;
	return { normalized, map };
}

export {
	processNoteTAArticle,
	updateInvalidCGroupTalkPage,
} from './article.ts';

export {
	extractVocabularies,
	parseLuaCGroup,
	parseWikitextCGroup,
	parseSystemConversionTable,
} from './parsers.ts';

export {
	LANG_CODE_RE,
	stripPattern,
	normalizeGroupName,
	getGroupNameFromTitle,
	normalizeConversionRule,
};
