import { MediaWikiApi } from 'wiki-saikou';
import config from '../utils/config.js';

const api = new MediaWikiApi(config.zh.api, {
	headers: { 'user-agent': config.useragent },
});

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	await api.login(
		config.zh.ibot.name,
		config.zh.ibot.password,
		undefined,
		{ retry: 25, noCache: true },
	).then(console.log);

	const pages = await (async () => {
		const NS_LIST = ['0', '1', '4', '5', '6', '7', '9', '10', '11', '12', '13', '14', '15', '274', '275', '711', '828', '829'];
		const result = await Promise.all(NS_LIST.map(async (ns) => {
			const { data: { query: { allpages } } } = await api.post({
				list: 'allpages',
				apnamespace: ns,
				apmaxsize: '15',
				aplimit: 'max',
			}, {
				retry: 15,
			});
			return allpages;
		}));
		return result.flat();
	})();
	
	let text = '* 本页面为[[U:星海-interfacebot|机器人]]生成的极短页面（不超过15字节），以供维护人员检查。\n* 不含{{ns:2}}、{{ns:3}}、{{ns:8}}命名空间的页面。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}\n\n{| class="wikitable sortable center plainlinks"\n|-\n! 序号 !! 页面ID !! 页面名 !! 操作\n';
	const titleRegex = /^(?:模块|Help|Template|Module):(?:Sandbox|沙盒)/;
	let count = 1;
	for (const page of pages) {
		const { pageid, title } = page;
		if (titleRegex.test(title)) {
			continue;
		}
		const linkText = `[{{canonicalurl:${title}|action=edit}} 编辑]｜[{{canonicalurl:${title}|action=history}} 历史]<span class="sysop-show">｜[{{canonicalurl:${title}|action=delete}} 删除]</span>`;
		text += `|-\n| ${count} || ${pageid} || [[:${title}]] || ${linkText}\n`;
		count++;
	}
	text += '|}\n\n[[Category:萌娘百科数据报告]]';

	await api.postWithToken('csrf', {
		action: 'edit',
		pageid: '540251',
		text,
		summary: '更新数据报告',
		bot: true,
		notminor: true,
		tags: 'Bot',
		watchlist: 'nochange',
	}, {
		retry: 50,
		noCache: true,
	}).then(({ data }) => console.log(JSON.stringify(data)));

	console.log(`End time: ${new Date().toISOString()}`);
})();
