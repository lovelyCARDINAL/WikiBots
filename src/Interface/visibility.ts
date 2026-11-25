import Parser from 'wikiparser-node';
import { createAndLogin } from '../utils/core/createApi.ts';
import { safePostWithToken } from '../utils/core/retry.ts';

Parser.config = 'moegirl';

const SITE_LIST = ['zh', 'cm'] as const;
const PAGE_LIST = [
	'MediaWiki:Autoblock_whitelist',
	'MediaWiki:Captcha-addurl-whitelist',
	'MediaWiki:Captcha-ip-whitelist',
	'MediaWiki:Echo-blacklist',
	'MediaWiki:Email-blacklist',
	'MediaWiki:Email-whitelist',
	'MediaWiki:External_image_whitelist',
	'MediaWiki:Filename-prefix-blacklist',
	'MediaWiki:Pageimages-blacklist',
	'MediaWiki:Spam-blacklist',
	'MediaWiki:Spam-whitelist',
	'MediaWiki:Titleblacklist',
	'MediaWiki:Titlewhitelist',
	'MediaWiki:Bad_image_list',
];

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	await Promise.all(SITE_LIST.map(async (site) => {
		const api = await createAndLogin(site, 'abot');

		const { data: { query: { pages } } } = await api.post<{
			query: { pages: Array<{ pageid: number; missing?: boolean; revisions: Array<{ content: string }> }> };
		}>({
			prop: 'revisions',
			titles: PAGE_LIST,
			rvprop: 'content',
		}, {
			retry: 25,
		});

		await Promise.all(pages
			.map(({ pageid, missing, revisions }): [number, string] | false => !missing && [pageid, revisions[0].content])
			.filter((item): item is [number, string] => Boolean(item))
			.map(async ([pageid, content]) => {
				const parser = Parser.parse(content, true);
				if (parser.text().length !== 0) {
					const firstNewline = content.indexOf('\n');
					const text = firstNewline === -1
						? content
						: `${content.slice(0, firstNewline)}<onlyinclude></onlyinclude>${content.slice(firstNewline)}`;
					await safePostWithToken(api, 'csrf', {
						action: 'edit',
						pageid,
						text,
						minor: true,
						bot: true,
						nocreate: true,
						tags: 'Bot',
						summary: 'Add onlyinclude tag',
						watchlist: 'nochange',
					}, {
						retry: 25,
						noCache: true,
					});
				}
			}),
		);
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();