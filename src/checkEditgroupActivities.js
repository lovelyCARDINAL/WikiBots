import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';

const zhapi = new MediaWikiApi(config.zh.api, {
		headers: { 'api-user-agent': config.apiuseragent },
	}),
	cmapi = new MediaWikiApi(config.cm.api, {
		headers: { 'api-user-agent': config.apiuseragent },
	});

const time = {
	start: new Date().toISOString(),
	end: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
};

function userInfo(user) {
	return `<img class="userlink-avatar-small" src="https://commons.moegirl.org.cn/extensions/Avatar/avatar.php?user=${user.replaceAll(' ', '_')}">{{User|${user}}}`;
}

async function queryContribs(api, ucuser) {
	const result = [];
	const eol = Symbol();
	let uccontinue = undefined;
	while (uccontinue !== eol) {
		const { data } = await api.post({
			list: 'usercontribs',
			uclimit: 'max',
			ucstart: time.start,
			ucend: time.end,
			ucnamespace: '0|10|14|12|4|6',
			ucuser,
			ucprop: '',
			...uccontinue && { uccontinue },
		}, {
			retry: 10,
		});
		uccontinue = data.continue ? data.continue.uccontinue : eol;
		result.push(...data.query.usercontribs);
	}
	return result;
}

async function updateData(text) {
	await zhapi.postWithToken('csrf', {
		action: 'edit',
		pageid: '544630',
		text,
		summary: '更新活跃度数据',
		bot: true,
		notminor: true,
		nocreate: true,
		tags: 'Bot',
		watchlist: 'nochange',
	}, {
		retry: 20,
		noCache: true,
	}).then(({ data }) => console.log(JSON.stringify(data)));
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	await Promise.all([
		zhapi.login(config.zh.ibot.name, config.zh.ibot.password).then(console.log),
		cmapi.login(config.cm.ibot.name, config.cm.ibot.password).then(console.log),
	]);

	const userlist = await (async () => {
		const { data: { parse: { wikitext } } } = await zhapi.post({
			action: 'parse',
			pageid: '490849',
			prop: 'wikitext',
		}, {
			retry: 10,
		});
		const regex = /{{User\|(.+?)}}/gi;
		const data = Array.from(wikitext.matchAll(regex), (match) => match[1]);
		return [...new Set(data)].sort();
	})();

	const data = await Promise.all([
		queryContribs(zhapi, userlist, '0|10|14|12|4|6'),
		queryContribs(cmapi, userlist, '0|10|14|12|4|6'),
	]).then((result) => result.flat());

	let text = '* 本页面为[[U:星海-interfacebot|机器人]]生成的编辑组负责人90日内中文萌娘百科与萌娘共享主、模板、分类、帮助、萌娘百科、文件名字空间下编辑数统计。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}\n<div style="display: flex; flex-wrap: wrap; justify-content: center;">\n<div style="min-width: 60%; margin:0 3rem 1rem">\n{| class="wikitable sortable" width=100%\n|-\n! 用户名 !! 编辑数\n';

	for (const user of userlist) {
		const contribsCount = data.filter((item) => item.user === user).length || 0;
		const count = contribsCount
			? contribsCount >= 3
				? `data-sort-value="${contribsCount}"|${contribsCount}次`
				: `data-sort-value="${contribsCount}"|<span style="color:red">${contribsCount}次</span>`
			: 'data-sort-value="0"|<i style="color:red">无相关编辑</i>';
		text += `|-\n| ${userInfo(user)} || ${count}\n`;
	}

	text += '|}\n</div>\n</div>\n\n[[Category:萌娘百科数据报告]]';
	
	await updateData(text);
	
	console.log(new Date().toISOString());
})();
