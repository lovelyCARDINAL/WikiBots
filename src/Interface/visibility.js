import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import config from '../utils/config.js';

Parser.config = 'moegirl';

const SITE_LIST = ['zh', 'cm'];
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
		const api = new MediaWikiApi(config[site].api, {
			headers: { 'user-agent': config.useragent },
		});
		await api.login(
			config[site].abot.name,
			config[site].abot.password,
			undefined,
			{ retry: 25, noCache: true },
		).then(console.log);

		const { data: { query: { pages } } } = await api.post({
			prop: 'revisions',
			titles: PAGE_LIST,
			rvprop: 'content',
		}, {
			retry: 25,
		});

		await Promise.all(pages
			.map(({ pageid, missing, revisions }) => !missing && [pageid, revisions[0].content])
			.filter(Boolean)
			.map(async ([pageid, content]) => {
				const parser = Parser.parse(content, true);
				if (parser.text().length !== 0) {
					await api.postWithToken('csrf', {
						action: 'edit',
						pageid,
						text: content.replace(/\n/, '<onlyinclude></onlyinclude>\n'),
						minor: true,
						bot: true,
						nocreate: true,
						tags: 'Bot',
						summary: 'Add onlyinclude tag',
						watchlist: 'nochange',
					}, {
						retry: 25,
						noCache: true,
					}).then(({ data }) => console.log(JSON.stringify(data)));
				}
			}),
		);
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();