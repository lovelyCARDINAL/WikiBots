import Parser from 'wikiparser-node';
import { normalizeConversionRule, normalizeGroupName } from './index.ts';

interface NoteTAContext {
	groupRules: Record<string, string[]>;
	groupAlias: Record<string, string>;
	summaryParts: string[];
	unregisteredGroups: Set<string>;
	activeGroupRules: Set<string>;
	seenNoteTARules: Set<string>;
	changed: boolean;
}

function resolveGroupParam(
	tpl: Parser.TranscludeToken,
	paramName: string,
	rawVal: string,
	ctx: NoteTAContext,
): void {
	let targetGroup = rawVal;
	if (!(targetGroup in ctx.groupRules)) {
		const resolved = ctx.groupAlias[targetGroup] || ctx.groupAlias[normalizeGroupName(targetGroup)];
		const bracketMatch = targetGroup.match(/^\[\[([^\][\n]+)\]\]$/);
		if (resolved && resolved in ctx.groupRules) {
			tpl.setValue(paramName, resolved);
			ctx.summaryParts.push(`修正公共转换组名：${rawVal}→${resolved}`);
			targetGroup = resolved;
			ctx.changed = true;
		} else if (bracketMatch && bracketMatch[1] in ctx.groupRules) {
			tpl.setValue(paramName, bracketMatch[1]);
			ctx.summaryParts.push(`修正公共转换组格式：${rawVal}→${bracketMatch[1]}`);
			targetGroup = bracketMatch[1];
			ctx.changed = true;
		} else {
			ctx.unregisteredGroups.add(rawVal);
			return;
		}
	}
	for (const rule of ctx.groupRules[targetGroup] || []) {
		ctx.activeGroupRules.add(rule);
	}
}

function pruneRedundantNumericRules(tpl: Parser.TranscludeToken, ctx: NoteTAContext): void {
	for (const arg of tpl.getAllArgs()) {
		const paramName = String(arg.name || '').trim();
		if (!/^\d+$/.test(paramName)) {
			continue;
		}
		const norm = normalizeConversionRule(arg.value || '');
		if (!norm) {
			continue;
		}
		if (!ctx.activeGroupRules.has(norm.normalized) && !ctx.seenNoteTARules.has(norm.normalized)) {
			ctx.seenNoteTARules.add(norm.normalized);
			continue;
		}
		tpl.removeArg?.(paramName);
		tpl.removeArg?.(`d${paramName}`);
		if (tpl.hasArg?.(paramName)) {
			tpl.setValue(paramName, '');
		}
		ctx.summaryParts.push('移除与公共转换组重复的NoteTA规则');
		ctx.changed = true;
	}
}

function processSingleNoteTA(tpl: Parser.TranscludeToken, ctx: NoteTAContext): boolean {
	for (const arg of tpl.getAllArgs()) {
		const paramName = String(arg.name || '').trim();
		const rawVal = (arg.value || '').trim();
		if (rawVal && /^G\d+$/i.test(paramName)) {
			resolveGroupParam(tpl, paramName, rawVal, ctx);
		}
	}
	pruneRedundantNumericRules(tpl, ctx);
	if (!tpl.getAllArgs().length) {
		tpl.remove();
		ctx.changed = true;
		return false;
	}
	return true;
}

function getNormalizedConverterRule(conv: Parser.Token): string | null {
	const rawRules = conv.childNodes
		.filter((n) => n.type === 'converter-rule')
		.map((n) => n.toString())
		.join(';');
	return normalizeConversionRule(rawRules)?.normalized ?? null;
}

function collectDeletedConverterRules(root: Parser.Token): Set<string> {
	const deletedRules = new Set<string>();
	for (const conv of root.querySelectorAll<Parser.ConverterToken>('converter')) {
		if (!conv.flags?.has('-')) {
			continue;
		}
		const norm = getNormalizedConverterRule(conv);
		if (norm) {
			deletedRules.add(norm);
		}
	}
	return deletedRules;
}

function hoistOrDeduplicateConverter(
	conv: Parser.ConverterToken,
	deletedRules: Set<string>,
	lastNoteTAToken: Parser.TranscludeToken | null,
	ctx: NoteTAContext,
): void {
	const isH = conv.flags?.has('H');
	const isA = conv.flags?.has('A');
	if (!isH && !isA || conv.flags?.has('-')) {
		return;
	}
	const norm = getNormalizedConverterRule(conv);
	if (!norm || deletedRules.has(norm)) {
		return;
	}

	const alreadyCovered = ctx.activeGroupRules.has(norm) || ctx.seenNoteTARules.has(norm);
	if (!alreadyCovered && lastNoteTAToken) {
		let nextIdx = 1;
		while (lastNoteTAToken.hasArg?.(String(nextIdx))) {
			nextIdx++;
		}
		if (nextIdx <= 30) {
			lastNoteTAToken.setValue(String(nextIdx), norm.replace(/;$/, ''));
			ctx.seenNoteTARules.add(norm);
			ctx.summaryParts.push('将全文转换规则移入NoteTA');
			ctx.changed = true;
		}
	}

	const nowCovered = alreadyCovered || ctx.seenNoteTARules.has(norm);
	if (!nowCovered) {
		return;
	}
	if (isH) {
		conv.remove();
		ctx.summaryParts.push(alreadyCovered ? '移除与NoteTA重复的全文转换' : '将H转换移入NoteTA');
		ctx.changed = true;
	} else if (isA) {
		conv.replaceWith(`-{${norm}}-`);
		ctx.summaryParts.push('移除与NoteTA重复的全文转换');
		ctx.changed = true;
	}
}

/**
 * Clean up an article's `{{NoteTA}}` templates and redundant `-{A|...}-`/`-{H|...}-`
 * conversion blocks against registered CGroups.
 */
function processNoteTAArticle(
	content: string,
	{ groupRules, groupAlias }: { groupRules: Record<string, string[]>; groupAlias: Record<string, string> },
): { changed: boolean; content: string; summaryParts: string[]; unregisteredGroups: string[] } {
	const NOTE_TA_RE = /^Template:NoteTA$/i;
	const root = Parser.parse(content);
	const ctx: NoteTAContext = {
		groupRules,
		groupAlias,
		summaryParts: [],
		unregisteredGroups: new Set<string>(),
		activeGroupRules: new Set<string>(),
		seenNoteTARules: new Set<string>(),
		changed: false,
	};

	let lastNoteTAToken: Parser.TranscludeToken | null = null;
	for (const tpl of root.querySelectorAll<Parser.TranscludeToken>('template')) {
		if (!NOTE_TA_RE.test(tpl.name)) {
			continue;
		}
		if (processSingleNoteTA(tpl, ctx)) {
			lastNoteTAToken = tpl;
		}
	}

	const deletedRules = collectDeletedConverterRules(root);
	for (const conv of root.querySelectorAll<Parser.ConverterToken>('converter')) {
		hoistOrDeduplicateConverter(conv, deletedRules, lastNoteTAToken, ctx);
	}

	return {
		changed: ctx.changed,
		content: ctx.changed ? root.toString() : content,
		summaryParts: [...new Set(ctx.summaryParts)],
		unregisteredGroups: [...ctx.unregisteredGroups],
	};
}

/**
 * Update or remove `{{Invalid CGroup}}` on an article's talk page.
 */
function updateInvalidCGroupTalkPage(
	talkContent: string,
	unregisteredGroups: string[],
): { changed: boolean; content: string; removed: boolean } {
	const INVALID_RE = /^Template:Invalid[ _]CGroup$/i;
	const root = Parser.parse(talkContent);
	const existing = root.querySelectorAll<Parser.TranscludeToken>('template').find((t) => INVALID_RE.test(t.name));

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
		return { changed: true, content: talkContent.trim() ? `${block}\n${talkContent}` : block, removed: false };
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
	processNoteTAArticle,
	updateInvalidCGroupTalkPage,
};
