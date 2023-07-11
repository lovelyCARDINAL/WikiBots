import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';

const SITE_LIST = ['zh', 'cm'];

console.log(`Start time: ${new Date().toISOString()}`);

(async () => {
	const { data: { query: { pages } } } = await new MediaWikiApi(config.zh.api, {
		headers: { 'api-user-agent': config.apiuseragent || '' },
	}).post({
		prop: 'revisions',
		titles: 'User:星海子/NulleditInCategory.json',
		rvprop: 'content',
	});
	const setting = JSON.parse(pages[0]?.revisions[0]?.content || '{}');
	
	await Promise.all(
		SITE_LIST.map(async (site) => {
			const api = new MediaWikiApi(config[site].api, {
				headers: {
					'api-user-agent': config.apiuseragent || '',
				},
			});
			await api.login(config[site].bot.name, config[site].bot.password);
			
			const catlist = [...setting[site], '尚未清空的已重定向分类', '尚未清空的消歧义分类'];

			await Promise.all(
				catlist.map(async (title) => {
					const { data: { query: { categorymembers } } } = await api.post({
						list: 'categorymembers',
						cmtitle: `Category:${title}`,
						cmnamespace: '*',
						cmlimit: 'max',
					});
					const pagelist = categorymembers.map(({ pageid }) => pageid);
					
					if (pagelist.length) {
						await Promise.all(
							pagelist.map(async (pageid) => {
								const { data } = await api.postWithToken('csrf', {
									action: 'edit',
									pageid,
									appendtext: '',
									minor: true,
									bot: true,
									tags: 'Bot',
									summary: '空编辑以刷新分类表',
								});
								console.log(data);
							}),
						);
					} else {
						console.log(`Site:${site}: Category:${title} is empty.`);
					}
				}),
			);
		}),
	);
	console.log(`End time: ${new Date().toISOString()}`);
})();