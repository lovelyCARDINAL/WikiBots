import type { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import { createAndLogin } from '../utils/createApi.ts';
import paginate from '../utils/paginate.ts';
import { safePostWithToken } from '../utils/retry.ts';

Parser.config = 'moegirl';

const time = {
	start: new Date().toISOString(),
	end: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
};

async function queryContribs(api: MediaWikiApi, ucuser: string[]): Promise<Array<{ user: string }>> {
	const result = [];
	for await (const data of paginate(api, {
		list: 'usercontribs',
		uclimit: 'max',
		ucstart: time.start,
		ucend: time.end,
		ucnamespace: '0|10|14|12|4|6',
		ucuser,
		ucprop: '',
	})) {
		if (data?.query?.usercontribs) {
			result.push(...data.query.usercontribs);
		}
	}
	return result;
}

async function updateData(zhapi: MediaWikiApi, text: string): Promise<void> {
	await safePostWithToken(zhapi, 'csrf', {
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
	});
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	const [zhapi, cmapi] = await Promise.all([
		createAndLogin('zh', 'ibot'),
		createAndLogin('cm', 'ibot'),
	]);

	const { data: { parse: { wikitext } } } = await zhapi.post<{ parse: { wikitext: string } }>({
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

	const userInfo = (user: string) => `{{#Avatar:${user}|class=userlink-avatar-small}}{{User|${user}}}`;

	const data = await Promise.all([
		queryContribs(zhapi, userlist),
		queryContribs(cmapi, userlist),
	]).then((result) => result.flat());

	const userContribsCount: Record<string, number> = {};
	for (const user of userlist) {
		const contribsCount = data.filter((item) => item.user === user).length || 0;
		userContribsCount[user] = contribsCount;
	}

	const parser = Parser.parse(wikitext);
	const table = parser.querySelector('table')!;
	const rowCount = table.getRowCount();
	let text = '* 本页面为[[U:星海-interfacebot|机器人]]生成的编辑组负责人30日内中文萌娘百科与萌娘共享主、模板、分类、帮助、萌娘百科、文件命名空间下编辑数统计。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}\n<div style="display: flex; flex-wrap: wrap; justify-content: center;">\n<div style="min-width: 60%; margin:0 3rem 1rem">\n{| class="wikitable sortable" width=100%\n|-\n! width=35%|编辑组 !! width=35%|用户名 !! 编辑数 !! 是否活跃';

	let lastGroup: string | undefined;
	for (let i = 2; i < rowCount; i++) {
		const groupCell = table.getNthCell({ y: i, x: 0 })!.innerText;
		if (groupCell === lastGroup) {
			continue;
		}
		lastGroup = groupCell;
		const users = (() => {
			const userCell = table.getNthCell({ y: i, x: 2 })!.innerText;
			const regex = /{{User\|(.+?)}}/gi;
			return Array.from(userCell.matchAll(regex), (match) => match[1]?.replace(/^\w/, (first) => first.toUpperCase()));
		})();
		const userCount = users.length;
		const isActive = Math.max(...users.map((user) => userContribsCount[user])) >= 3
			? '是'
			: '<b style="color:red">否</b>';
		const userContribs = (user: string) => {
			const contribsCount = userContribsCount[user];
			return contribsCount >= 3
				? `data-sort-value="${contribsCount}"|${contribsCount}次`
				: `data-sort-value="${contribsCount}"|<span style="color:red">${contribsCount}次</span>`;
		};
		text += userCount === 1 
			? `\n|-\n|${groupCell} || ${userInfo(users[0])} || ${userContribs(users[0])} || ${isActive}`
			: `\n|-\n| rowspan=${userCount}|${groupCell} || ${userInfo(users[0])} || ${userContribs(users.shift()!)} || rowspan=${userCount} |${isActive}${users.map((user) => `\n|-\n| ${userInfo(user)} || ${userContribs(user)}`).join('')}`;
	}

	text += '\n|-\n|}\n</div>\n</div>\n\n[[Category:萌娘百科数据报告]]';
	
	await updateData(zhapi, text);
	
	console.log(new Date().toISOString());
})();
