import type { MediaWikiApi } from 'wiki-saikou';
import { createAndLogin } from '../utils/core/createApi.ts';
import { safePostWithToken } from '../utils/core/retry.ts';

const SITE_LIST = ['zh', 'cm'] as const;
type Site = (typeof SITE_LIST)[number];
const api = {} as Record<Site, MediaWikiApi>;

interface ProtectionItem {
	type: string;
	level: string;
	expiry: string;
}

const PROTECTION_MAP: Record<'missing' | 'normal', ProtectionItem[]> = {
	missing: [
		{ type: 'create', level: 'sysop', expiry: 'infinity' },
	],
	normal: [
		{ type: 'edit', level: 'sysop', expiry: 'infinity' },
		{ type: 'move', level: 'sysop', expiry: 'infinity' },
	],
};

function isEqual(array: ProtectionItem[], key: 'missing' | 'normal'): boolean {
	return array.length === PROTECTION_MAP[key].length && array.every(({ type, level, expiry }, index) => {
		const { type: type2, level: level2, expiry: expiry2 } = PROTECTION_MAP[key][index];
		return type === type2 && level === level2 && expiry === expiry2;
	});
}

async function protect(site: Site, title: string, protections: string | ProtectionItem[]): Promise<void> {
	await safePostWithToken(api[site], 'csrf', {
		action: 'protect',
		title,
		protections: protections as string,
		expiry: 'infinite',
		reason: '公告、原因表单和黑白名单等仅限管理员使用的页面',
		tags: 'Bot',
		watchlist: 'nochange',
	}, {
		retry: 50,
		noCache: true,
	});
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	console.groupCollapsed('LOGIN');
	await Promise.all(SITE_LIST.map(async (site) => {
		api[site] = await createAndLogin(site, 'abot');
	}));
	console.groupEnd();

	const pageGroup = await (async () => {
		const { data: { query: { pages: [{ revisions: [{ content }] }] } } } = await api.zh.post<{
			query: { pages: Array<{ revisions: Array<{ content: string }> }> };
		}>({
			prop: 'revisions',
			titles: 'User:星海子/BotConfig/interfaceProtection.json',
			rvprop: 'content',
		}, {
			retry: 15,
		});
		const setData = JSON.parse(content) as Record<string, { site: Site[]; title: string[] }>;
		const results: Partial<Record<Site, string[]>> = {};
		Object.keys(setData).forEach((key) => {
			setData[key].site.forEach((site) => {
				results[site] = results[site]
					?.concat(setData[key].title.map((title) => `MediaWiki:${title}`))
					|| setData[key].title.map((title) => `MediaWiki:${title}`);
			});
		});
		return results;
	})();

	await Promise.all(SITE_LIST.map(async (site) => {
		await api[site].post<{ query: { pages: Array<{ title: string; missing?: boolean; protection: ProtectionItem[] }> } }>({
			prop: 'info',
			titles: pageGroup[site],
			inprop: 'protection',
		}, {
			retry: 15,
		}).then(async ({ data: { query: { pages } } }) => {
			console.groupCollapsed(site.toUpperCase());
			await Promise.all(pages.map(async({ title, missing, protection }) => {
				const expected = missing ? 'missing' : 'normal';
				if (isEqual(protection, expected)) {
					console.log(`${title} is protected`);
				} else {
					await protect(site, title, protection);
				}
			}));
			console.groupEnd();
		});
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();