import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import config from '../utils/config.js';

Parser.config = 'moegirl';

const zhapi = new MediaWikiApi(config.zh.api, {
		headers: { 'user-agent': config.useragent },
	}),
	cmapi = new MediaWikiApi(config.cm.api, {
		headers: { 'user-agent': config.useragent },
	});

const time = {
	start: new Date().toISOString(),
	end: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
};

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
			uccontinue,
		}, {
			retry: 15,
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
		retry: 50,
		noCache: true,
	}).then(({ data }) => console.log(JSON.stringify(data)));
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	await Promise.all([
		zhapi.login(
			config.zh.ibot.name,
			config.zh.ibot.password,
			undefined,
			{ retry: 25, noCache: true },
		).then(console.log),
		cmapi.login(
			config.cm.ibot.name,
			config.cm.ibot.password,
			undefined,
			{ retry: 25, noCache: true },
		).then(console.log),
	]);

	const { data: { parse: { wikitext } } } = await zhapi.post({
		action: 'parse',
		pageid: '490849',
		prop: 'wikitext',
	}, {
		retry: 15,
	});

	const userlist = (() => {
		const regex = /{{User\|(.+?)}}/gi;
		const data = Array.from(wikitext.matchAll(regex), (match) => match[1]?.replace(/^\w/, (first) => first.toUpperCase()));
		return [...new Set(data)].sort();
	})();

	const userInfo = (user) => `{{#Avatar:${user}|class=userlink-avatar-small}}{{User|${user}}}`;

	const data = await Promise.all([
		queryContribs(zhapi, userlist, '0|10|14|12|4|6'),
		queryContribs(cmapi, userlist, '0|10|14|12|4|6'),
	]).then((result) => result.flat());

	const userContribsCount = {};
	for (const user of userlist) {
		const contribsCount = data.filter((item) => item.user === user).length || 0;
		userContribsCount[user] = contribsCount;
	}

	const parser = Parser.parse(wikitext);
	/** @type {Parser.TableToken} */
	const table = parser.querySelector('table');
	const rowCount = table.getRowCount();
	let text = '* 本页面为[[U:星海-interfacebot|机器人]]生成的编辑组负责人90日内中文萌娘百科与萌娘共享主、模板、分类、帮助、萌娘百科、文件命名空间下编辑数统计。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}\n<div style="display: flex; flex-wrap: wrap; justify-content: center;">\n<div style="min-width: 60%; margin:0 3rem 1rem">\n{| class="wikitable sortable" width=100%\n|-\n! width=35%|编辑组 !! width=35%|用户名 !! 编辑数 !! 是否活跃';

	for (let i = 1; i < rowCount; i++) {
		const groupCell = String(table.getNthCell({ row: i, column: 0 })).trim();
		const users = (() => {
			const userCell = String(table.getNthCell({ row: i, column: 2 }));
			const regex = /{{User\|(.+?)}}/gi;
			return Array.from(userCell.matchAll(regex), (match) => match[1]?.replace(/^\w/, (first) => first.toUpperCase()));
		})();
		const userCount = users.length;
		const isActive = Math.max(...users.map((user) => userContribsCount[user])) >= 3
			? '是'
			: '<b style="color:red">否</b>';
		const userContribs = (user) => {
			const contribsCount = userContribsCount[user];
			return contribsCount >= 3
				? `data-sort-value="${contribsCount}"|${contribsCount}次`
				: `data-sort-value="${contribsCount}"|<span style="color:red">${contribsCount}次</span>`;
		};
		text += userCount === 1 
			? `\n|-\n${groupCell} || ${userInfo(users[0])} || ${userContribs(users[0])} || ${isActive}`
			: `\n|-\n| rowspan=${userCount}${groupCell} || ${userInfo(users[0])} || ${userContribs(users.shift())} || rowspan=${userCount} |${isActive}${users.map((user) => `\n|-\n| ${userInfo(user)} || ${userContribs(user)}`).join('')}`;
	}

	text += '\n|-\n|}\n</div>\n</div>\n\n[[Category:萌娘百科数据报告]]';
	
	await updateData(text);
	
	console.log(new Date().toISOString());
})();
