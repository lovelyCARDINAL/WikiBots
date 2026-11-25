import Parser from 'wikiparser-node';
import type { MwQueryResponse } from '../types/mediawiki.d.ts';
import mapLimit from '../utils/concurrency.ts';
import { createAndLogin } from '../utils/createApi.ts';
import { safePostWithToken } from '../utils/retry.ts';

Parser.config = 'moegirl';

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	const api = await createAndLogin('zh', 'abot');

	const { data: { query: { pages: [{ revisions: [{ content }] }] } } } = await api.post<MwQueryResponse<{
		pages: Array<{ revisions: Array<{ content: string }> }>;
	}>>({
		prop: 'revisions',
		titles: '萌娘百科:长期破坏者',
		rvprop: 'content',
	}, {
		retry: 25,
	});

	const root = Parser.parse(content, false, 10); // 不解析语言变体转换
	const selector = 'list + link[name^=User:], list + html#span + link[name^=User:]';
	const users = root.querySelectorAll(selector);
	const linesWithTemplate = new Set(root.querySelectorAll('template#Template:No_abuselog').map((token) => token.getBoundingClientRect().top));
	const time = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

	await mapLimit(users, 5, async (user) => {
		const rect = user.getBoundingClientRect();
		const name = user.name?.slice(5);
		if (!name) {
			return;
		}
		const endLine = rect.top + rect.height - 1;
		if (!linesWithTemplate.has(endLine)) {
			const { data: { query: { abuselog, usercontribs } } } = await api.post<MwQueryResponse<{
				abuselog: unknown[];
				usercontribs: unknown[];
			}>>({
				list: 'abuselog|usercontribs',
				afluser: name,
				afllimit: '1',
				uclimit: '1',
				ucend: time,
				ucuser: name,
			}, {
				retry: 25,
			});
			if (!abuselog.length && !usercontribs.length) {
				user.after(' {{No abuselog}}');
			}
		}
	});

	await safePostWithToken(api, 'csrf', {
		action: 'edit',
		title: '萌娘百科:长期破坏者',
		text: String(root),
		bot: true,
		nocreate: true,
		tags: 'Bot',
		summary: '更新长期破坏者账号状态',
		watchlist: 'nochange',
	}, {
		retry: 50,
		noCache: true,
	});

	console.log(`End time: ${new Date().toISOString()}`);
})();
