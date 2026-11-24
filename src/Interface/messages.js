import moment from 'moment';
import { MediaWikiApi } from 'wiki-saikou';
import config from '../utils/config.js';

const SITE_LIST = ['zh', 'cm'];
const api = {};

const SUMMARY = {
	Abusefilter: '同步滥用过滤器消息',
	Titleblacklist: '同步标题黑名单警告消息',
	Gadget: '同步小工具界面消息',
	Widget: '同步微件页面',
};

/**
 * 从指定站点的 MediaWiki:Gadgets-definition 解析所有 gadget 名称。
 * @param {MediaWikiApi} siteApi
 * @returns {Promise<string[]>}
 */
async function parseGadgetNames(siteApi) {
	const { data: { query: { pages: [{ revisions: [{ content }] }] } } } = await siteApi.post({
		prop: 'revisions',
		titles: 'MediaWiki:Gadgets-definition',
		rvprop: 'content',
	}, {
		retry: 15,
	});
	return content
		.split('\n')
		.filter((line) => line.startsWith('*'))
		.map((line) => line.replace(/^\*\s*/, '').split(/[\s[|]/)[0])
		.filter(Boolean);
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	console.groupCollapsed('LOGIN');
	await Promise.all(SITE_LIST.map(async(site) => {
		api[site] = new MediaWikiApi({
			baseURL: config[site].api,
			fexiosConfigs: {
				headers: { 'user-agent': config.useragent },
			},
		});
		await api[site].login(
			config[site].ibot.name,
			config[site].ibot.password,
			undefined,
			{ retry: 25, noCache: true },
		).then((result) => console.log(site, result));
	}));
	console.groupEnd();

	const pageGroup = await (async () => {
		const { data: { query: { pages: [{ revisions: [{ content }] }] } } } = await api.zh.post({
			prop: 'revisions',
			titles: 'User:星海子/BotConfig/interfaceMessages.json',
			rvprop: 'content',
		}, {
			retry: 15,
		});
		const setData = JSON.parse(content);
		const suffixes = ['', '/zh-hans', '/zh-cn', '/zh-hant', '/zh-tw', '/zh-hk'];

		// 从 cm 站 Gadgets-definition 解析 gadget 列表，排除 JSON 配置中的黑名单
		const gadgetExclude = new Set(setData.Gadget?.exclude ?? []);
		const gadgetSite = setData.Gadget?.site ?? ['cm'];
		const gadgetNames = await parseGadgetNames(api.cm);
		const gadgetPages = gadgetNames
			.filter((name) => !gadgetExclude.has(name))
			.flatMap((name) => suffixes
				.map((suffix) => [`MediaWiki:Gadget-${name}${suffix}`, 'Gadget', gadgetSite]),
			);

		// 从 JSON 配置读取其余分组（Abusefilter、Titleblacklist、Widget）
		const configPages = Object.entries(setData)
			.filter(([key]) => key !== 'Gadget')
			.flatMap(([key, value]) => {
				// Widget 命名空间不需要拼接 /zh-hans 等语言后缀，且 title 应包含或自动补全 Widget: 前缀
				if (key === 'Widget') {
					return value.title.map((title) => [
						title.startsWith('Widget:') ? title : `Widget:${title}`,
						key,
						value.site,
					]);
				}
				return value.title.flatMap((title) => suffixes
					.map((suffix) => [`MediaWiki:${title}${suffix}`, key, value.site]),
				);
			});

		return [...gadgetPages, ...configPages];
	})();

	const time = moment().subtract(16, 'days');

	const pagelist = await (async () => {
		const { data: { query: { pages } } } = await api.zh.post({
			prop: 'revisions',
			titles: pageGroup.map(([title]) => title),
			rvprop: 'timestamp|content',
		}, {
			retry: 15,
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
				retry: 50,
				noCache: true,
			}).then(({ data }) => console.log(JSON.stringify(data)));
		}));
		console.groupEnd();
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();
