import Parser from 'wikiparser-node';

Parser.config = 'moegirl';

const LANG_CODE_RE = /^(?:zh|zh-(?:hans|hant|cn|tw|hk))$/i;

/**
 * Normalize a CGroup name for fuzzy/alias matching.
 *
 * @param {string} groupName
 * @returns {string}
 */
function normalizeGroupName(groupName: string): string {
	return groupName
		.replace(/[\s_\-–()（）{}「」#＝]/g, '')
		.replace(/^CGroup\//i, '')
		.replace(/^=+/g, '')
		.replace(/<\/?\w[^<>]*>/g, '')
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

/**
 * Parse a `Module:CGroup/...` Lua module source to extract conversion items,
 * included group names, and redirect targets.
 *
 * @param {string} luaSource
 * @returns {{ rules: string[], transclusions: string[], redirectTo: string | null, error: string | null }}
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

	const transclusions: string[] = [];
	for (const m of cleaned.matchAll(/import\s*\(\s*['"](?:Module:CGroup\/)?([^'"]+)['"]\s*\)/g)) {
		if (m[1]) {
			transclusions.push(m[1].trim());
		}
	}

	const rules: string[] = [];
	const itemRe = /\{\s*type\s*=\s*['"]item['"]\s*,([\s\S]*?)\}/g;
	for (const match of cleaned.matchAll(itemRe)) {
		const body = match[1];
		const ruleMatch = body.match(/\brule\s*=\s*(['"])([\s\S]*?)\1/);
		if (ruleMatch?.[2]) {
			const norm = normalizeConversionRule(ruleMatch[2]);
			if (norm) {
				rules.push(norm.normalized);
			}
			continue;
		}
		// Handle key-value style: ['zh-cn'] = '...', ['zh-tw'] = '...'
		const parts = [];
		const kvRe = /\[\s*['"]([^'"]+)['"]\s*\]\s*=\s*(['"])([\s\S]*?)\2/g;
		for (const kv of body.matchAll(kvRe)) {
			if (LANG_CODE_RE.test(kv[1])) {
				parts.push(`${kv[1]}:${kv[3]}`);
			}
		}
		if (parts.length >= 2) {
			const norm = normalizeConversionRule(parts.join(';'));
			if (norm) {
				rules.push(norm.normalized);
			}
		}
	}

	// Fallback: also catch shorthand Item(nil|'original'|false, 'rule') calls
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
 *
 * @param {string} wikitext
 * @returns {{ rules: string[], transclusions: string[], redirectTo: string | null }}
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

	for (const tpl of root.querySelectorAll('template')) {
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
	const stripped = wikitext.replace(/<!--[\s\S]*?-->/g, '');
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

/**
 * Clean up an article's `{{NoteTA}}` templates and redundant `-{A|...}-`/`-{H|...}-`
 * conversion blocks against registered CGroups.
 *
 * @param {string} content
 * @param {object} context
 * @param {Record<string, string[]>} context.groupRules
 * @param {Record<string, string>} context.groupAlias
 * @returns {{ changed: boolean, content: string, summaryParts: string[], unregisteredGroups: string[] }}
 */
function processNoteTAArticle(
	content: string,
	{ groupRules, groupAlias }: { groupRules: Record<string, string[]>; groupAlias: Record<string, string> },
): { changed: boolean; content: string; summaryParts: string[]; unregisteredGroups: string[] } {
	const NOTE_TA_RE = /^Template:NoteTA$/i;
	const root = Parser.parse(content);
	const summaryParts: string[] = [];
	const unregisteredGroups = new Set<string>();
	const activeGroupRules = new Set<string>();
	const seenNoteTARules = new Set<string>();
	let lastNoteTAToken: Parser.TranscludeToken | null = null;
	let changed = false;

	for (const tpl of root.querySelectorAll('template')) {
		if (!NOTE_TA_RE.test(tpl.name)) {
			continue;
		}
		lastNoteTAToken = tpl;
		for (const arg of tpl.getAllArgs()) {
			const paramName = String(arg.name || '').trim();
			const rawVal = (arg.value || '').trim();
			if (!rawVal) {
				continue;
			}

			if (/^G\d+$/i.test(paramName)) {
				let targetGroup = rawVal;
				if (!(targetGroup in groupRules)) {
					const norm = normalizeGroupName(targetGroup);
					const resolved = groupAlias[targetGroup] || groupAlias[norm];
					const bracketMatch = targetGroup.match(/^\[\[([^\][\n]+)\]\]$/);
					if (resolved && resolved in groupRules) {
						tpl.setValue(paramName, resolved);
						summaryParts.push(`修正公共转换组名：${rawVal}→${resolved}`);
						targetGroup = resolved;
						changed = true;
					} else if (bracketMatch && bracketMatch[1] in groupRules) {
						tpl.setValue(paramName, bracketMatch[1]);
						summaryParts.push(`修正公共转换组格式：${rawVal}→${bracketMatch[1]}`);
						targetGroup = bracketMatch[1];
						changed = true;
					} else {
						unregisteredGroups.add(rawVal);
						continue;
					}
				}
				for (const rule of groupRules[targetGroup] || []) {
					activeGroupRules.add(rule);
				}
			}
		}

		// Second pass on numeric rule parameters (1..30)
		for (const arg of tpl.getAllArgs()) {
			const paramName = String(arg.name || '').trim();
			if (!/^\d+$/.test(paramName)) {
				continue;
			}
			const norm = normalizeConversionRule(arg.value || '');
			if (!norm) {
				continue;
			}
			if (activeGroupRules.has(norm.normalized) || seenNoteTARules.has(norm.normalized)) {
				tpl.removeArg?.(paramName);
				tpl.removeArg?.(`d${paramName}`);
				if (tpl.hasArg?.(paramName)) {
					tpl.setValue(paramName, '');
				}
				summaryParts.push('移除与公共转换组重复的NoteTA规则');
				changed = true;
			} else {
				seenNoteTARules.add(norm.normalized);
			}
		}

		if (!tpl.getAllArgs().length) {
			tpl.remove();
			if (lastNoteTAToken === tpl) {
				lastNoteTAToken = null;
			}
			changed = true;
		}
	}

	// Collect rules explicitly disabled via -{-|...}- so we never hoist them into {{NoteTA}}
	const deletedRules = new Set();
	for (const conv of root.querySelectorAll('converter')) {
		if (conv.flags?.has('-')) {
			const rawRules = conv.childNodes
				.filter((n) => n.type === 'converter-rule')
				.map((n) => n.toString())
				.join(';');
			const norm = normalizeConversionRule(rawRules);
			if (norm) {
				deletedRules.add(norm.normalized);
			}
		}
	}

	// Move -{H|...}- / -{A|...}- into {{NoteTA}} or remove when already covered
	for (const conv of root.querySelectorAll('converter')) {
		const isH = conv.flags?.has('H');
		const isA = conv.flags?.has('A');
		if (!isH && !isA || conv.flags?.has('-')) {
			continue;
		}
		const rawRules = conv.childNodes
			.filter((n) => n.type === 'converter-rule')
			.map((n) => n.toString())
			.join(';');
		const norm = normalizeConversionRule(rawRules);
		if (!norm || deletedRules.has(norm.normalized)) {
			continue;
		}

		const alreadyCovered = activeGroupRules.has(norm.normalized) || seenNoteTARules.has(norm.normalized);
		if (!alreadyCovered && lastNoteTAToken) {
			let nextIdx = 1;
			while (lastNoteTAToken.hasArg?.(String(nextIdx))) {
				nextIdx++;
			}
			if (nextIdx <= 30) {
				lastNoteTAToken.setValue(String(nextIdx), norm.normalized.replace(/;$/, ''));
				seenNoteTARules.add(norm.normalized);
				summaryParts.push('将全文转换规则移入NoteTA');
				changed = true;
			}
		}

		if (isH && (alreadyCovered || seenNoteTARules.has(norm.normalized))) {
			conv.remove();
			summaryParts.push(alreadyCovered ? '移除与NoteTA重复的全文转换' : '将H转换移入NoteTA');
			changed = true;
		} else if (isA && (alreadyCovered || seenNoteTARules.has(norm.normalized))) {
			// Strip A| flag so inline display stays intact without duplicating global registration
			conv.replaceWith(`-{${norm.normalized}}-`);
			summaryParts.push('移除与NoteTA重复的全文转换');
			changed = true;
		}
	}

	return {
		changed,
		content: changed ? root.toString() : content,
		summaryParts: [...new Set(summaryParts)],
		unregisteredGroups: [...unregisteredGroups],
	};
}

/**
 * Update or remove `{{Invalid CGroup}}` on an article's talk page.
 *
 * @param {string} talkContent
 * @param {string[]} unregisteredGroups
 * @returns {{ changed: boolean, content: string, removed: boolean }}
 */
function updateInvalidCGroupTalkPage(
	talkContent: string,
	unregisteredGroups: string[],
): { changed: boolean; content: string; removed: boolean } {
	const INVALID_RE = /^Template:Invalid[ _]CGroup$/i;
	const root = Parser.parse(talkContent);
	const existing = root.querySelectorAll('template').find((t) => INVALID_RE.test(t.name));

	if (!unregisteredGroups.length) {
		if (!existing) {
			return { changed: false, content: talkContent, removed: false };
		}
		const prev = existing.previousSibling;
		const next = existing.nextSibling;
		const atLineStart = !prev || prev.type === 'text' && /\n$/.test(prev.data);
		if (atLineStart && next?.type === 'text' && next.data.startsWith('\n')) {
			next.replaceData(next.data.slice(1));
		}
		existing.remove();
		return { changed: true, content: root.toString(), removed: true };
	}

	const groupArgs = unregisteredGroups.join('|');
	if (!existing) {
		const block = `{{Invalid CGroup|${groupArgs}}}`;
		const newContent = talkContent.trim() ? `${block}\n${talkContent}` : block;
		return { changed: true, content: newContent, removed: false };
	}

	const existingArgs = existing.getAllArgs().map((a) => (a.value || '').trim()).filter(Boolean);
	if (existingArgs.length === unregisteredGroups.length
		&& unregisteredGroups.every((g) => existingArgs.includes(g))) {
		return { changed: false, content: talkContent, removed: false };
	}

	existing.replaceWith(`{{Invalid CGroup|${groupArgs}}}`);
	return { changed: true, content: root.toString(), removed: false };
}

export {
	normalizeGroupName,
	getGroupNameFromTitle,
	normalizeConversionRule,
	extractVocabularies,
	parseLuaCGroup,
	parseWikitextCGroup,
	parseSystemConversionTable,
	processNoteTAArticle,
	updateInvalidCGroupTalkPage,
};
