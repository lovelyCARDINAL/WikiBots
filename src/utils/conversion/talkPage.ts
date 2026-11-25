import Parser from 'wikiparser-node';

/**
 * Update or remove `{{Invalid CGroup}}` on an article's talk page.
 */
export function updateInvalidCGroupTalkPage(
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
