import type { MediaWikiApi } from 'wiki-saikou';
import type { MwPageContentResponse } from '../../types/mediawiki.d.ts';
import { safePostWithToken } from '../core/retry.ts';

/**
 * Remove a deletion-request template from a page that cannot be auto-deleted.
 */
export async function removeDeletionTemplate(api: MediaWikiApi, pageid: number, templatePattern: RegExp): Promise<void> {
	const { data } = await api.post<MwPageContentResponse>({
		prop: 'revisions',
		pageids: pageid,
		rvprop: 'content',
	}, {
		retry: 15,
	});
	const content = data?.query?.pages?.[0]?.revisions?.[0]?.content;
	if (content === undefined) {
		return;
	}
	const wikitext = content.replaceAll(templatePattern, '');
	await safePostWithToken(api, 'csrf', {
		action: 'edit',
		pageid,
		tags: 'Bot',
		watchlist: 'nochange',
		text: wikitext,
		minor: true,
		bot: true,
		summary: '无法自动删除，请至[[萌娘百科_talk:讨论版/操作申请]]提请维护人员删除。',
	}, {
		retry: 50,
		noCache: true,
	});
}

/**
 * Delete a page by page ID with the given reason.
 */
export async function deletePageById(api: MediaWikiApi, pageid: number, reason: string): Promise<void> {
	await safePostWithToken(api, 'csrf', {
		action: 'delete',
		pageid,
		reason,
		tags: 'Bot',
		watchlist: 'nochange',
	}, {
		retry: 50,
		noCache: true,
	});
}
