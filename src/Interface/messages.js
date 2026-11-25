import moment from 'moment';
import { MediaWikiApi } from 'wiki-saikou';
import config from '../utils/config.js';
import { safePostWithToken } from '../utils/retry.js';

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
	try {
		const { data } = await siteApi.post({
			prop: 'revisions',
			titles: 'MediaWiki:Gadgets-definition',
			rvprop: 'content',
		}, {
			retry: 15,
		});
		const content = data?.query?.pages?.[0]?.revisions?.[0]?.content;
		if (!content) {
			console.warn('MediaWiki:Gadgets-definition 未找到有效内容，跳过 Gadget 同步');
			process.exitCode = 1;
			return [];
		}
		return content
			.split('\n')
			.filter((line) => line.startsWith('*'))
			.map((line) => line.replace(/^\*\s*/, '').split(/[|[]/)[0].trim())
			.filter(Boolean);
	} catch (error) {
		console.error('读取 MediaWiki:Gadgets-definition 失败，跳过 Gadget 同步:', error);
		process.exitCode = 1;
		return [];
	}
}

/**
 * 将 MediaWiki query.pages 转换为按标题索引的 Map（兼容 normalized 标题）。
 * @param {object} data
 * @returns {Map<string, object>}
 */
function buildPageMap(data) {
	const pageMap = new Map();
	const normalizedMap = new Map(
		(data?.query?.normalized ?? []).map(({ from, to }) => [to, from]),
	);
	for (const page of data?.query?.pages ?? []) {
		pageMap.set(page.title, page);
		const originalTitle = normalizedMap.get(page.title);
		if (originalTitle) {
			pageMap.set(originalTitle, page);
		}
	}
	return pageMap;
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
		const { data: zhData } = await api.zh.post({
			prop: 'revisions',
			titles: pageGroup.map(([title]) => title),
			rvprop: 'timestamp|content',
		}, {
			retry: 15,
		});
		const zhPages = buildPageMap(zhData);

		// 对于 16 天内未编辑的 Gadget 页面，检查目标站点是否缺失或内容过期，避免新启用小工具的消息被跳过
		const staleGadgetCandidates = pageGroup.filter(([title, key]) => {
			if (key !== 'Gadget') {
				return false;
			}
			const page = zhPages.get(title);
			const rev = page?.revisions?.[0];
			return page && !page.missing && rev && !moment(rev.timestamp).isAfter(time);
		});

		const targetPageMaps = new Map();
		if (staleGadgetCandidates.length > 0) {
			const targetSites = [...new Set(staleGadgetCandidates.flatMap(([, , sites]) => sites))]
				.filter((site) => api[site]);
			await Promise.all(targetSites.map(async (site) => {
				const siteTitles = staleGadgetCandidates
					.filter(([, , sites]) => sites.includes(site))
					.map(([title]) => title);
				const { data: targetData } = await api[site].post({
					prop: 'revisions',
					titles: siteTitles,
					rvprop: 'content',
				}, {
					retry: 15,
				});
				targetPageMaps.set(site, buildPageMap(targetData));
			}));
		}

		return pageGroup.flatMap((item) => {
			const [title, key, sites] = item;
			const zhPage = zhPages.get(title);
			const zhRev = zhPage?.revisions?.[0];
			if (!zhPage || zhPage.missing || !zhRev) {
				return [];
			}
			if (moment(zhRev.timestamp).isAfter(time)) {
				return [ [...item, zhRev.content] ];
			}
			if (key !== 'Gadget') {
				return [];
			}
			const sitesToSync = sites.filter((site) => {
				const targetPage = targetPageMaps.get(site)?.get(title);
				const targetContent = targetPage?.revisions?.[0]?.content;
				return !targetPage || targetPage.missing || targetContent !== zhRev.content;
			});
			return sitesToSync.length > 0 ? [ [title, key, sitesToSync, zhRev.content] ] : [];
		});
	})();

	await Promise.all(SITE_LIST.splice(1).map(async (site) => {
		console.groupCollapsed(site.toUpperCase());
		const pages = pagelist.filter((item) => item[2].includes(site));
		await Promise.all(pages.map(async ([title, key, , text]) => {
			await safePostWithToken(api[site], 'csrf', {
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
			});
		}));
		console.groupEnd();
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();
