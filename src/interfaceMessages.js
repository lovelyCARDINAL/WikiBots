import moment from 'moment';
import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';

const SITE_LIST = ['zh', 'cm'];
const api = {};

const SUMMARY = {
	Abusefilter: '同步滥用过滤器消息',
	Titleblacklist: '同步标题黑名单警告消息',
};

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	console.groupCollapsed('LOGIN');
	await Promise.all(SITE_LIST.map(async(site) => {
		api[site] = new MediaWikiApi(config[site].api, { headers: { 'api-user-agent': config.apiuseragent } });
		await api[site].login(config[site].ibot.name, config[site].ibot.password).then((result) => console.log(site, result));
	}));
	console.groupEnd();

	const pageGroup = await (async () => {
		const { data: { query: { pages: [{ revisions: [{ content }] }] } } } = await api.zh.post({
			prop: 'revisions',
			titles: 'User:星海子/BotConfig/interfaceMessages.json',
			rvprop: 'content',
		});
		const setData = JSON.parse(content);
		const suffixes = ['', '/zh-hans', '/zh-cn', '/zh-hant', '/zh-tw', '/zh-hk'];

		return Object.entries(setData)
			.flatMap(([key, value]) => value.title
				.flatMap((title) => suffixes
					.map((suffix) => [`MediaWiki:${title}${suffix}`, key, value.site]),
				),
			);
	})();

	const time = moment().subtract(300, 'days');

	const pagelist = await (async () => {
		const { data: { query: { pages } } } = await api.zh.post({
			prop: 'revisions',
			titles: pageGroup.map(([title]) => title),
			rvprop: 'timestamp|content',
		});
		const result = pages
			.filter(({ missing, revisions }) => !missing && moment(revisions[0].timestamp).isAfter(time))
			.map(({ title, revisions }) => [title, revisions[0].content]);
		return pageGroup
			.filter((item) => result.map(([title]) => title).includes(item[0]))
			.map((item) => {
				const content = result.find((subArray) => subArray[0] === item[0])[1];
				return [...item, content];
			});
	})();

	await Promise.all(SITE_LIST.splice(1).map(async (site) => {
		console.groupCollapsed(site.toUpperCase());
		const pages = pagelist.filter((item) => item[2].includes(site));
		await Promise.all(pages.map(async ([title, key, , text]) => {
			await api[site].postWithToken('csrf', {
				action: 'edit',
				title,
				text,
				tags: 'Bot',
				bot: true,
				minor: true,
				summary: SUMMARY[key] || '同步界面消息',
				watchlist: 'nochange',
			}, {
				retry: 10,
				noCache: true,
			}).then(({ data }) => console.log(JSON.stringify(data)));
		}));
		console.groupEnd();
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();
