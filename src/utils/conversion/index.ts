import Parser from 'wikiparser-node';

Parser.config = 'moegirl';

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

/**
 * Strip Lua block (`--[[...]]`) and line (`--...`) comments while preserving string literals.
 *
 * @param {string} source
 * @returns {string}
 */
function stripLuaComments(source: string): string {
	return source.replace(
		/(['"])(?:\\.|(?!\1)[^\\\r\n])*\1|--\[(=*)\[[\s\S]*?\]\2\]|--[^\r\n]*/g,
		(match: string, quote?: string) => quote ? match : '',
	);
}

function parseLuaItemBody(body: string): string | null {
	const ruleMatch = body.match(/\brule\s*=\s*(['"])([\s\S]*?)\1/);
	if (ruleMatch?.[2]) {
		return normalizeConversionRule(ruleMatch[2])?.normalized ?? null;
	}
	const parts: string[] = [];
	for (const kv of body.matchAll(/\[\s*['"]([^'"]+)['"]\s*\]\s*=\s*(['"])([\s\S]*?)\2/g)) {
		if (LANG_CODE_RE.test(kv[1])) {
			parts.push(`${kv[1]}:${kv[3]}`);
		}
	}
	return parts.length >= 2 ? normalizeConversionRule(parts.join(';'))?.normalized ?? null : null;
}

/**
 * Parse a `Module:CGroup/...` Lua module source to extract conversion items,
 * included group names, and redirect targets.
 */
function parseLuaCGroup(luaSource: string): {
	rules: string[];
	transclusions: string[];
	redirectTo: string | null;
	error: string | null;
} {
	if (!luaSource || typeof luaSource !== 'string') {
		return { rules: [], transclusions: [], redirectTo: null, error: 'Empty module' };
	}

	const cleaned = stripLuaComments(luaSource);
	const redirectMatch = cleaned.match(/return\s+require\s*\(\s*['"](Module:CGroup\/[^'"]+)['"]\s*\)/);
	if (redirectMatch) {
		return { rules: [], transclusions: [], redirectTo: redirectMatch[1], error: null };
	}

	const transclusions = Array.from(
		cleaned.matchAll(/import\s*\(\s*['"](?:Module:CGroup\/)?([^'"]+)['"]\s*\)/g),
		(m) => m[1]?.trim(),
	).filter((s): s is string => Boolean(s));

	const rules: string[] = [];
	for (const match of cleaned.matchAll(/\{\s*type\s*=\s*['"]item['"]\s*,([\s\S]*?)\}/g)) {
		const normalized = parseLuaItemBody(match[1]);
		if (normalized) {
			rules.push(normalized);
		}
	}

	const shortItemRe = /\bItem\s*\(\s*(?:nil|false|(['"])(?:\\.|(?!\1)[^\\])*\1)\s*,\s*(['"])([\s\S]*?)\2\s*\)/g;
	for (const match of cleaned.matchAll(shortItemRe)) {
		const norm = normalizeConversionRule(match[3]);
		if (norm) {
			rules.push(norm.normalized);
		}
	}

	return {
		rules: [...new Set(rules)],
		transclusions: [...new Set(transclusions)],
		redirectTo: null,
		error: null,
	};
}

/**
 * Parse a `Template:CGroup/...` or `MediaWiki:Conversiontable/...` wikitext page.
 */
function parseWikitextCGroup(wikitext: string): {
	rules: string[];
	transclusions: string[];
	redirectTo: string | null;
} {
	if (!wikitext) {
		return { rules: [], transclusions: [], redirectTo: null };
	}
	const redirectMatch = wikitext.match(/^\s*#(?:REDIRECT|重定向)\s*\[\[([^\]]+)\]\]/i);
	if (redirectMatch) {
		return { rules: [], transclusions: [], redirectTo: redirectMatch[1].trim() };
	}

	const root = Parser.parse(wikitext);
	const rules: string[] = [];
	const transclusions: string[] = [];

	for (const tpl of root.querySelectorAll<Parser.TranscludeToken>('template')) {
		if (/^Template:CGroup\//i.test(tpl.name)) {
			const nameArg = getGroupNameFromTitle(tpl.name);
			if (nameArg && nameArg !== 'core') {
				transclusions.push(nameArg);
			}
		}
		if (/^Template:CGroup\/core$/i.test(tpl.name) || /Item$/i.test(tpl.name)) {
			for (const arg of tpl.getAllArgs()) {
				const norm = normalizeConversionRule(arg.value);
				if (norm) {
					rules.push(norm.normalized);
				}
			}
		}
	}

	for (const conv of root.querySelectorAll('converter')) {
		const rawRules = conv.childNodes
			.filter((n) => n.type === 'converter-rule')
			.map((n) => n.toString())
			.join(';');
		const norm = normalizeConversionRule(rawRules);
		if (norm) {
			rules.push(norm.normalized);
		}
	}

	return {
		rules: [...new Set(rules)],
		transclusions: [...new Set(transclusions)],
		redirectTo: null,
	};
}

/**
 * Extract all individual vocabulary terms from an array of normalized conversion rules.
 *
 * @param {string[]} rules
 * @returns {string[]}
 */
function extractVocabularies(rules: string[]): string[] {
	const words = new Set<string>();
	for (const rule of rules) {
		const norm = normalizeConversionRule(rule);
		if (!norm) {
			continue;
		}
		for (const word of Object.values(norm.map)) {
			if (word) {
				words.add(word);
			}
		}
	}
	return [...words].sort();
}

/**
 * Parse a `MediaWiki:Conversiontable/*` system conversion page.
 * Supports `* from => to ;` bullet rules as well as `-{...}-` blocks.
 *
 * @param {string} wikitext
 * @returns {{ rules: string[], vocabularies: string[], transclusions: string[], redirectTo: string | null }}
 */
function parseSystemConversionTable(wikitext: string): {
	rules: string[];
	vocabularies: string[];
	transclusions: string[];
	redirectTo: string | null;
} {
	if (!wikitext) {
		return { rules: [], vocabularies: [], transclusions: [], redirectTo: null };
	}
	const base = parseWikitextCGroup(wikitext);
	if (base.redirectTo) {
		return { ...base, vocabularies: [] };
	}

	const vocab = new Set(extractVocabularies(base.rules));
	const stripped = stripPattern(wikitext, /<!--[\s\S]*?-->/g);
	for (const line of stripped.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('*')) {
			continue;
		}
		const body = trimmed.replace(/^\*+\s*/, '');
		for (const segment of body.split(';')) {
			const arrowIdx = segment.indexOf('=>');
			if (arrowIdx === -1) {
				continue;
			}
			const from = segment.slice(0, arrowIdx).trim();
			const to = segment.slice(arrowIdx + 2).trim();
			if (from) {
				vocab.add(from);
			}
			if (to) {
				vocab.add(to);
			}
		}
	}

	return {
		rules: base.rules,
		vocabularies: [...vocab].sort(),
		transclusions: base.transclusions,
		redirectTo: null,
	};
}

export {
	processNoteTAArticle,
	updateInvalidCGroupTalkPage,
} from './article.ts';

export {
	normalizeGroupName,
	getGroupNameFromTitle,
	normalizeConversionRule,
	extractVocabularies,
	parseLuaCGroup,
	parseWikitextCGroup,
	parseSystemConversionTable,
};
