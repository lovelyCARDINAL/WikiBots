import type { MediaWikiApi } from 'wiki-saikou';
import type { MwPageContentResponse } from '../types/mediawiki.d.ts';
import mapLimit from '../utils/concurrency.ts';
import { createAndLogin } from '../utils/createApi.ts';
import { safePostWithToken } from '../utils/retry.ts';

async function edit(api: MediaWikiApi, title: string, text: string, summary?: string) {
	await safePostWithToken(api, 'csrf', {
		action: 'edit',
		title,
		text,
		summary: summary || '修复不必要的URL编码',
		tags: 'Bot',
		minor: true,
		bot: true,
		nocreate: true,
		watchlist: 'nochange',
	}, {
		retry: 25,
		noCache: true,
	});
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	const api = await createAndLogin('zh', 'ibot');
	
	const { data: { query: { pages: [{ revisions: [{ content }] }] } } } = await api.post<MwPageContentResponse>({
		prop: 'revisions',
		titles: '萌娘百科:可能存在语法错误的条目',
		rvprop: 'content',
	}, {
		retry: 20,
	});
	let wikitext = content;
	const pages = content.match(/\n(?:\|rowspan=\d+)?\|\[\[.+?\]\](?:\n\|内链中不必要的URL编码\|\|第\s*\d+\s*行第\s*\d+\s*列\s*⏤\s*第\s*\d+\s*行第\s*\d+\s*列\n\|<pre>.+?<\/pre>\n\|-)+/g);

	if (pages) {
		await mapLimit(pages, 5, async (page) => {
			const title = page.match(/^\n(?:\|rowspan=\d+)?\|\[\[:?(.+?)\]\]/)![1];
			const rows = (page
				.match(/\|内链中不必要的URL编码\|\|第\s*(\d+)\s*行第\s*\d+\s*列 ⏤ 第\s*(\d+)\s*行第\s*\d+\s*列\n/g) ?? [])
				.map((line) => line.match(/第\s*(\d+)\s*行/g)!.map((match) => parseInt(match.match(/\d+/)![0])))
				.map(([start, end]) => Array.from({ length: end - start + 1 }, (_, i) => start + i - 1))
				.flat();
			const { data: { query: { pages: [{ revisions: [{ content }] }] } } } = await api.post<MwPageContentResponse>({
				prop: 'revisions',
				titles: title,
				rvprop: 'content',
			}, {
				retry: 20,
			});
			const lines = content.split('\n');
			let flag = true;
			for (const row of rows) {
				const line = lines[row];
				if (/"%5b|%5d|%7b|%7c|%7d"/.test(line)) {
					flag = false;
					continue;
				}
				lines[row] = decodeURIComponent(lines[row]);
			}
			if (flag) {
				wikitext = wikitext.replace(page, '');
			}
			await edit(api, title, lines.join('\n'));
		});

		if (wikitext !== content) {
			await edit(api, '萌娘百科:可能存在语法错误的条目', wikitext, '移除已修复的语法错误');
		}
	} else {
		console.log('No pages found.');
	}

	console.log(`End time: ${new Date().toISOString()}`);
})();