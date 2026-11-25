import Parser from 'wikiparser-node';
import { createAndLogin } from '../utils/core/createApi.ts';
import { safePostWithToken } from '../utils/core/retry.ts';

function templateCount(parsed: Parser.Token | Parser.AstRange): number {
	const templates = parsed.querySelectorAll<Parser.TranscludeToken>('template#Template:China_Temple_Song, template#Template:Temple_Song, template#Template:China_Legendary_Song');
	return templates.filter((template) => template.getValue('nocount') !== 'true').length;
}

function sectionCount(parsed: Parser.Token, setData: Record<string, Record<string, Record<string, number>>>, root: string, sub: string): void {
	parsed.sections()
		?.slice(1) // 忽略序言
		.forEach((section) => {
			const header = (section.firstChild as { innerText?: string } | undefined)?.innerText ?? '';
			if (header in setData[root][sub]) {
				setData[root][sub][header] = templateCount(section);
			}
		});
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	const api = await createAndLogin('zh', 'ibot');

	const { data: { query: { pages: [{ revisions: [{ content: setPage }] }] } } } = await api.post<{
		query: { pages: Array<{ revisions: Array<{ content: string }> }> };
	}>({
		prop: 'revisions',
		titles: 'Module:VOCALOID_Song_Counter/data.json',
		rvprop: 'content',
	}, {
		retry: 15,
	});
	const setData = JSON.parse(setPage);
	const titles = Object.keys(setData).flatMap((page) => {
		if (typeof setData[page] === 'number') {
			return page;
		}
		if (typeof setData[page].root === 'number' || setData[page]?.section
			|| setData[page]?.['bilibili投稿'] || setData[page]?.['YouTube投稿']) {
			return Object.keys(setData[page]).flatMap((subpage) => {
				const result = [];
				switch (subpage) {
					case 'root':
					case 'section':
						result.push(page);
						break;
					case 'bilibili投稿':
					case 'YouTube投稿':
						if (typeof setData[page][subpage] === 'number') {
							result.push(`${page}/${subpage}`);
						} else {
							result.push(...Object.keys(setData[page][subpage]).map((subsub) => `${page}/${subpage}/${subsub}`));
						}
						break;
					default:
						result.push(`${page}/${subpage}`);
						break;
				}
				return result;
			});
		}
		return Object.keys(setData[page]).map((subpage) => `${page}/${subpage}`);
	});

	const { data: { query: { pages } } } = await api.post<{
		query: { pages: Array<{ title: string; revisions: Array<{ content: string }> }> };
	}>({
		prop: 'revisions',
		titles,
		rvprop: 'content',
	}, {
		retry: 15,
	});

	await Promise.all(pages.map(({ title, revisions: [{ content }] }) => {
		const [root, sub, subsub] = title.split(/\/(?!Ego)/);
		const parsed = Parser.parse(content);
		switch (sub) {
			case undefined:
				if (typeof setData[root]?.root === 'number') {
					setData[root].root = templateCount(parsed);
				} else if (setData[root]?.section) {
					sectionCount(parsed, setData, root, 'section');
				} else {
					setData[root] = templateCount(parsed);
				}
				break;
			case '梗曲相关':
				sectionCount(parsed, setData, root, sub);
				break;
			case 'YouTube投稿':
			case 'bilibili投稿':
				if (subsub) {
					setData[root][sub][subsub] = templateCount(parsed);
				} else {
					setData[root][sub] = templateCount(parsed);
				}
				break;
			default:
				setData[root][sub] = templateCount(parsed);
				break;
		}
	}));
	
	await safePostWithToken(api, 'csrf', {
		action: 'edit',
		title: 'Module:VOCALOID_Song_Counter/data.json',
		text: JSON.stringify(setData),
		summary: '更新歌曲统计数据',
		bot: true,
		tags: 'Bot',
		watchlist: 'nochange',
	}, {
		retry: 50,
		noCache: true,
	});
	
	console.log(`End time: ${new Date().toISOString()}`);
})();
