import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';

const api = new MediaWikiApi(config.zh.api, { headers: { 'api-user-agent': config.apiuseragent } });

console.log(`Start time: ${new Date().toISOString()}`);

(async () => {
	await api.login(config.zh.ibot.name, config.zh.ibot.password).then(console.log);

	const { data: { query: { pages } } } = await api.post({
		prop: 'info',
		generator: 'querypage',
		inprop: 'protection',
		gqppage: 'Mostlinkedtemplates',
		gqplimit: 'max',
	});
	const { data: { query: { querypage: { results } } } } = await api.post({
		list: 'querypage',
		qppage: 'Mostlinkedtemplates',
		qplimit: 'max',
	});
    
	let text = '* 本页面由[[U:星海-interfacebot|机器人]]根据[[Special:MostTranscludedPages]]生成页面保护信息以供管理员检查。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}\n\n{| class="wikitable sortable center plainlinks"\n|-\n! 序号 !! 页面名 !! 使用量 !! 编辑 !! 移动 !! 操作\n';
	let count = 1;
	for (const item of results) {
		const { title, value } = item;
		const match = pages.find((page) => page.title === title);
		const { protection } = match;
		const levelStr = { edit: ' - ||', move: ' - ||' };
		for (const option of protection) {
			const { type, expiry, level } = option;
			levelStr[type] = expiry === 'infinity' ? ` {{int:Protect-level-${level}}} ||` : ' - ||';
		}
		const linkText = `<span class="patroller-show">[{{canonicalurl:${title}|action=edit}} 编辑]｜</span>[{{canonicalurl:${title}|action=history}} 历史]<span class="sysop-show">｜[{{canonicalurl:${title}|action=protect}} 保护]</span>`;
		text += `|-\n| ${count} || [[${title}]] || ${value} || ${levelStr.edit + levelStr.move + linkText}\n`;
		count++;
	}
	text += '|}\n\n[[Category:萌娘百科数据报告]]';

	const { data } = await api.postWithToken('csrf', {
		action: 'edit',
		pageid: '539846',
		text,
		summary: '更新数据报告',
		bot: true,
		notminor: true,
		tags: 'Bot',
		watchlist: 'nochange',
	});
	console.log(JSON.stringify(data));

	console.log(`End time: ${new Date().toISOString()}`);
})();
