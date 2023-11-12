import { MediaWikiApi } from 'wiki-saikou';
import config from '../utils/config.js';

const SITE_LIST = ['zh', 'cm'];

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	const zhapi = new MediaWikiApi(config.zh.api, {
		headers: { 'api-user-agent': config.apiuseragent },
	});
	await zhapi.login(
		config.zh.bot.name,
		config.zh.bot.password,
		undefined,
		{ retry: 25, noCache: true },
	).then(console.log);

	const { data: { query: { pages: [{ revisions: [{ content }] }] } } } = await zhapi.post({
		prop: 'revisions',
		titles: 'User:星海子/BotConfig/nulleditInCategory.json',
		rvprop: 'content',
	}, {
		retry: 15,
	});
	const setting = JSON.parse(content || '{}');
	
	await Promise.all(
		SITE_LIST.map(async (site) => {
			let api;
			if (site === 'zh') {
				api = zhapi;
			} else {
				api = new MediaWikiApi(config[site].api, {
					headers: { 'api-user-agent': config.apiuseragent },
				});
				await api.login(
					config[site].bot.name,
					config[site].bot.password,
					undefined,
					{ retry: 25, noCache: true },
				).then(console.log);
			}
			
			const catlist = [...setting[site], '尚未清空的已重定向分类', '尚未清空的消歧义分类'];

			await Promise.all(
				catlist.map(async (title) => {
					const { data: { query: { categorymembers } } } = await api.post({
						list: 'categorymembers',
						cmtitle: `Category:${title}`,
						cmnamespace: '*',
						cmlimit: 'max',
					}, {
						retry: 15,
					});
					const pagelist = categorymembers.map(({ pageid }) => pageid);
					
					if (pagelist.length) {
						await Promise.all(
							pagelist.map(async (pageid) => {
								await api.postWithToken('csrf', {
									action: 'edit',
									pageid,
									appendtext: '',
									minor: true,
									bot: true,
									nocreate: true,
									tags: 'Bot',
									summary: '空编辑以刷新分类表',
									watchlist: 'nochange',
								}, {
									retry: 50,
									noCache: true,
								}).then(({ data }) => console.log(JSON.stringify(data)));
							}),
						);
					} else {
						console.log(`Site:${site} Category:${title} is empty.`);
					}
				}),
			);
		}),
	);
	console.log(`End time: ${new Date().toISOString()}`);
})();