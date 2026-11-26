import type { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import type { MwQueryResponse } from '../types/mediawiki.d.ts';
import { createAndLogin } from '../utils/core/createApi.ts';
import { safePostWithToken } from '../utils/core/retry.ts';

Parser.config = 'moegirl';

const time = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();

async function isActive(api: MediaWikiApi, user: string): Promise<boolean> {
	const { data } = await api.post<MwQueryResponse<{
		usercontribs?: unknown[];
	}>>({
		list: 'usercontribs',
		ucuser: user,
		ucnamespace: '*',
		uclimit: '1',
		ucend: time,
	}, {
		retry: 15,
	});
	return !(data?.query?.usercontribs ?? []).length;
}

async function edit(api: MediaWikiApi, pageid: string, text: string): Promise<void> {
	await safePostWithToken(api, 'csrf', {
		action: 'edit',
		pageid,
		text,
		summary: '移除超过180日不活跃的编辑组成员',
		tags: 'Bot',
		notminor: true,
		bot: true,
		nocreate: true,
		watchlist: 'nochange',
	}, {
		retry: 50,
		noCache: true,
	});
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	const api = await createAndLogin('zh', 'abot');

	const pageids: { signature: string[]; template: string[] } = {
		signature: [],
		template: ['420215', '582333'],
	};

	// signature
	await Promise.all(pageids.signature.map(async (pageid) => {
		const { data } = await api.post<{ parse?: { wikitext?: string } }>({
			action: 'parse',
			pageid,
			prop: 'wikitext',
		}, {
			retry: 15,
		});
		const wikitext = data?.parse?.wikitext;
		if (!wikitext) {
			return;
		}

		const lines = wikitext.split('\n');
		const inactiveLines = new Set<string>();
		await Promise.all(lines.map(async (line) => {
			if (!line.startsWith('#')) {
				return;
			}
			const parsedLine = Parser.parse(line);
			// 取最后一个用户页、用户讨论页、用户贡献内部链接中的用户名
			const username = parsedLine.querySelectorAll('link')
				.map(({ name }) => name)
				.filter((name): name is string => Boolean(name && /^(?:(?:user|u|user[ _]talk):[^/]+$|(?:Special|特殊):(?:(?:用[户戶]|使用者)?[贡貢]献|Contrib(?:ution)?s)\/)/i.test(name)))
				.at(-1)
				?.replace(/^user:|u:|user[ _]talk:|(Special|特殊):((用[户戶]|使用者)?[贡貢]献|Contrib(ution)?s)\//i, '');
			if (!username) {
				console.warn(`username not found: ${line}`);
				return;
			}
			if (await isActive(api, username)) {
				inactiveLines.add(line);
			}
		}));

		const text = lines.filter((item) => !inactiveLines.has(item)).join('\n');
		if (text === wikitext) {
			console.log(`No change: ${pageid}`);
			return;
		}
		await edit(api, pageid, text);
	}));

	// template
	await Promise.all(pageids.template.map(async (pageid) => {
		const { data } = await api.post<{
			parse?: { wikitext?: string; links?: Array<{ ns: number; title: string }> };
		}>({
			action: 'parse',
			pageid,
			prop: 'wikitext|links',
		}, {
			retry: 15,
		});
		const wikitext = data?.parse?.wikitext;
		const links = data?.parse?.links ?? [];
		if (!wikitext) {
			return;
		}

		// {{User}}与{{Supu}}均包含User talk内部链接
		const inactive = (await Promise.all(links
			.filter(({ ns }) => ns === 3)
			.map(({ title }) => !title.includes('/') ? title.replace('User talk:', '') : '')
			.filter(Boolean)
			.map(async (user) => await isActive(api, user) ? user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : ''),
		)).filter(Boolean);

		if (!inactive.length) {
			console.log(`No change: ${pageid}`);
			return;
		}

		const content = Parser.parse(wikitext);
		const templates = content.querySelectorAll<Parser.TranscludeToken>('template#Template:Hlist');
		const regex = new RegExp(`{{\\s*(?:User|Supu)\\s*\\|\\s*(?:${inactive.join('|')})\\s*[|}]`, 'i');

		for (const temp of templates) {
			for (const arg of temp.getAllArgs()) {
				if (regex.test(arg.value.trim())) {
					arg.remove();
				}
			}
		}

		const text = content.toString();
		if (text === wikitext) {
			console.log(`No change: ${pageid}`);
			return;
		}
		await edit(api, pageid, text);
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();
