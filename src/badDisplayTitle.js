import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import config from './utils/config.js';

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

	const pages = await (async () => {
		const result = [];
		const eol = Symbol();
		let geicontinue = undefined;
		while (geicontinue !== eol) {
			const { data } = await api.post({
				prop: 'revisions',
				generator: 'embeddedin',
				rvprop: 'content',
				rvsection: '0',
				geititle: 'Template:标题替换',
				geinamespace: '0',
				geifilterredir: 'nonredirects',
				geilimit: '500',
				geicontinue,
			}, {
				retry: 15,
			});
			geicontinue = data.continue ? data.continue.geicontinue : eol;
			result.push(...Object.values(data.query.pages).filter((page) => page.revisions));
		}
		return result;
	})();

	let text = '* 本页面为[[U:星海-interfacebot|机器人]]生成的疑似错误使用{{tlx|标题替换}}模板的条目，完成修复的<b>任何用户</b>都可以<b class="plainlinks">[{{fullurl:{{FULLPAGENAME}}|action=edit}} 编辑下方表格]</b>。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}\n\n* 可能由于以下原因被列入此表：\n** 缺失<code>t=1</code>参数或{{tlx|lang}}标记；\n** 可使用<code>t=1</code>参数或{{tlx|NoteTA}}替代；\n** 花里胡哨、奇怪写法或误判。\n\n{| class="wikitable sortable plainlinks" width=100%\n|-\n! 序号 || 页面ID || 条目名 || style="width:60%"|参数 || style="width:10%"|编辑序言\n';
	let count = 1;
	for (const page of pages) {
		const { pageid, title, revisions: [{ content }] } = page;
		const wikitext = Parser.parse(content.replaceAll('\n', '').replace(/[标標][题題]替[换換]|替[换換][标標][题題]/, '标题替换'));
		const params = wikitext.querySelector('template#Template:标题替换')?.getValue();
		if (!params || params?.t && !['no', 'n', 'false', '0', '', '¬'].includes(params.t?.trim())) {
			continue;
		}
		const param1 = params?.['1'];
		if (param1) {
			if (/^(?:[\u0020-\u3fff\uff01-\uffff]|[\ud800-\udbff][\udc00-\udfff])+$/.test(param1)) {
				continue;
			}
			const inner = Parser.parse(param1);
			const innerTemp = inner.querySelector('template')?.name;
			if (innerTemp && ['Template:Lang', 'Template:Lj'].includes(innerTemp)) {
				continue;
			}
		} else if (params?.['zh-hans']?.trim() !== title || params?.['zh-cn']?.trim() !== title) {
			continue;
		}
		const output = (() => {
			let result = '';
			for (const key of Object.keys(params)) {
				result += `${key}：<code><nowiki>${params[key]}</nowiki></code><br>`;
			}
			return result.replace(/<br>$/, '');
		})();
		text += `|-\n| ${count} || ${pageid} || [[${title}]] || ${output} || [{{canonicalurl:${title}|action=edit&section=0}} 编辑]\n`;
		count++;
	}
	text += '|}\n\n[[Category:萌娘百科数据报告]][[Category:积压工作]]';

	await api.postWithToken('csrf', {
		action: 'edit',
		pageid: '573287',
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
