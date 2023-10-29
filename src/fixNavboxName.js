import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import config from './utils/config.js';
import splitAndJoin from './utils/splitAndJoin.js';

const api = new MediaWikiApi(config.zh.api, {
	headers: { 'api-user-agent': config.apiuseragent },
});

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	await api.login(
		config.zh.ibot.name,
		config.zh.ibot.password,
		undefined,
		{ retry: 25, noCache: true },
	).then(console.log);

	const { data: { query: { search } } } = await api.post({
		list: 'search',
		srsearch: 'hastemplate:"navbox" insource:"name" insource:"navbox"',
		srnamespace: '10',
		srlimit: 'max',
		srinfo: '',
		srprop: '',
	}, {
		retry: 25,
	});

	const ids = search
		.filter(({ title }) => !/Template:(?:Navbox|大家族)|\/doc/.test(title))
		.map(({ pageid }) => pageid);
	const idslist = splitAndJoin(ids, 500);

	await Promise.all(idslist.map(async (pageids) => {
		const { data: { query: { pages } } } = await api.post({
			prop: 'revisions',
			pageids,
			rvprop: 'content',
		}, {
			retry: 25,
		});
		await Promise.all(pages.map(async ({ title, revisions: [{ content }] }) => {
			const wikitext = Parser.parse(content, true);
			const name = wikitext.querySelector('template#Template:Navbox, template#Template:大家族, template#Template:Navbox_with_columns, template#Template:Navbox_with_collapsible_groups, magic-word#invoke[module=Module:Nav]')?.getValue('name')?.trim();
			if (!name) {
				console.log(`${title} 找不到navbox或缺失name参数。`);
				return;
			}
			const value = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
			const titleValue = title.replace('Template:', '');
			if (value.replaceAll('_', ' ') !== titleValue) {
				const regex = new RegExp(`(\\|\\s*name\\s*=\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
				await api.postWithToken('csrf', {
					action: 'edit',
					title,
					text: content.replace(regex, `$1${titleValue}`),
					bot: true,
					tags: 'Bot',
					watchlist: 'nochange',
					summary: `修复Navbox模板name参数：${name} → ${titleValue}`,
				}, {
					retry: 50,
					noCache: true,
				}).then(({ data }) => console.log(JSON.stringify(data)));
			}
		}));
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();
