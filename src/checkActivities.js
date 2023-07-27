import axios from 'axios';
import axiosRetry from 'axios-retry';
import moment from 'moment';
import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';

const zhapi = new MediaWikiApi(config.zh.api, { headers: { 'api-user-agent': config.apiuseragent } }),
	cmapi = new MediaWikiApi(config.cm.api, { headers: { 'api-user-agent': config.apiuseragent } });

const now = moment().utc();
const time = {
	0: now.toISOString(),
	30: now.subtract(30, 'days').toISOString(),
	90: now.subtract(60, 'days').toISOString(),
	180: now.subtract(90, 'days').toISOString(),
	365: now.subtract(185, 'days').toISOString(),
};

axiosRetry(axios, {
	retries: 5,
	retryDelay: (retryCount) => {
		return retryCount * 1000;
	},
});

function userInfo(user) {
	return `<img class="userlink-avatar-small" src="https://commons.moegirl.org.cn/extensions/Avatar/avatar.php?user=${user.replaceAll(' ', '_')}">{{User|${user}}}`;
}

function timestampCST(timestamp) {
	return `${moment(timestamp).utcOffset('+08:00').format('YYYY-MM-DD HH:mm:ss')} (CST)`;
}

async function queryContribs(api, ucuser, ucnamespace, ucend) {
	const result = [];
	const eol = Symbol();
	let uccontinue = undefined;
	while (uccontinue !== eol) {
		const { data } = await api.post({
			list: 'usercontribs',
			uclimit: 'max',
			ucstart: time[0],
			ucend,
			ucnamespace,
			ucuser,
			ucprop: 'title|timestamp',
			...uccontinue && { uccontinue },
		});
		uccontinue = data.continue ? data.continue.uccontinue : eol;
		result.push(...data.query.usercontribs);
	}
	return result;
}

async function queryLatestContribs(api, ucuser, ucnamespace, ucend) {
	const { data: { query: { usercontribs } } } = await api.post({
		list: 'usercontribs',
		uclimit: '1',
		ucstart: time[0],
		ucend,
		ucnamespace,
		ucuser,
		ucprop: 'timestamp',
	});
	return usercontribs?.[0]?.timestamp;
}

async function queryLatestEvents(api, user, end) {
	const { data: { query: { usercontribs, logevents } } } = await api.post({
		list: 'usercontribs|logevents',
		uclimit: '1',
		lelimit: '1',
		ucstart: time[0],
		lestrat: time[0],
		ucend: end,
		leend: end,
		ucnamespace:'*',
		ucuser: user,
		leuser: user,
		ucprop: 'timestamp',
		leprop: 'timestamp',
		uctag: 'Bot',
		letag: 'Bot',
	});
	const contribsTimestamp = usercontribs.length
		? timestampCST(usercontribs[0].timestamp)
		: api === cmapi || [ 'AnnAngela-cbot', '星海-oversightbot', '萌百娘' ].includes(user)
			? '-'
			: '<i style="color:red">无相关编辑</i>';
	const logeventsTimestamp = logevents.length
		? timestampCST(logevents[0].timestamp)
		: '-';
	return `|| ${contribsTimestamp} || ${logeventsTimestamp} `;
}

async function updateData(pageid, text) {
	const { data } = await zhapi.postWithToken('csrf', {
		action: 'edit',
		pageid,
		text,
		summary: '更新活跃度数据',
		bot: true,
		notminor: true,
		nocreate: true,
		tags: 'Bot',
		watchlist: 'nochange',
	});
	console.log(JSON.stringify(data));
}

console.log(`Start time: ${new Date().toISOString()}`);

(async () => {
	await zhapi.login(config.zh.ibot.name, config.zh.ibot.password).then(console.log);
	
	const userData = await (async () => {
		const [ { data: { query: { pages: [ { revisions: [ { content } ] } ] } } },
			{ data: { query: { allusers } } } ] = await Promise.all([
			zhapi.post({
				prop: 'revisions',
				titles: 'Module:UserGroup/data',
				rvprop: 'content',
			}),
			zhapi.post({
				list: 'allusers',
				augroup: 'bot',
				aulimit: 'max',
			}),
		]);
		const data = JSON.parse(content);
		const filterBots = [ '滥用过滤器', 'Abuse filter', '不正利用フィルター', 'Delete page script', '重定向修复器' ];
		data.bot = allusers.filter((user) => !filterBots.includes(user.name)).map((user) => user.name);
		return data;
	})();

	await cmapi.login(config.cm.ibot.name, config.cm.ibot.password).then(console.log);

	const maintainTable = async () => {
		const userStr = [ ...userData.sysop, ...userData.patroller ].join('|');
		const data = await Promise.all([
			queryContribs(zhapi, userStr, '0|10|14|12|4|6', time[30]),
			queryContribs(cmapi, userStr, '0|10|14|12|4|6', time[30]),
		]).then((result) => result.flat());
	
		let text = '* 本页面为[[U:星海-interfacebot|机器人]]生成的维护人员30日内中文萌娘百科与萌娘共享主、模板、分类、帮助、萌娘百科、文件名字空间下编辑数统计。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}\n<div style="display: flex; flex-wrap: wrap; justify-content: center;">\n<div style="width: 100%; max-width: 600px; margin:0 3rem 1rem">\n{| class="wikitable sortable" width=100%\n|+ 管理员\n|-\n! 用户名 !! 编辑数 !! 最后编辑时间\n';
	
		const processUser = (group) => {
			for (const user of userData[group]) {
				const contribsData = data.filter((item) => item.user === user) || [];
				const contribsCount = contribsData.length;
				const count = contribsCount 
					? contribsCount >= 3
						? `data-sort-value="${contribsCount}"|${contribsCount}次`
						: `data-sort-value="${contribsCount}"|<span style="color:red">${contribsCount}次</span>`
					: 'data-sort-value="0"|<i style="color:red">无相关编辑</i>';
				const timestamp = contribsCount
					? timestampCST(moment.max(contribsData.map((item) => moment(item.timestamp))))
					: '<i style="color:red">无相关编辑</i>';
				text += `|-\n| ${userInfo(user)} || ${count} || ${timestamp}\n`;
			}
		};
	
		processUser('sysop');

		text += '|}\n</div>\n<div style="width: 100%; max-width: 600px; margin:0 3rem 1rem">\n{| class="wikitable sortable" width=100%\n|+ 巡查姬\n|-\n! 用户名 !! 编辑数 !! 最后编辑时间\n';

		processUser('patroller');

		text += '|}\n</div>\n</div>\n\n[[Category:萌娘百科数据报告]]';
		
		await updateData('540045', text);
	};

	const techTable = async () => {
		const { data: ghiaData } = await axios.get('https://raw.githubusercontent.com/MoegirlPediaInterfaceAdmins/MoegirlPediaInterfaceCodes/master/src/global/zh/MediaWiki:GHIAHistory.json');
		const processData = [
			Promise.all([
				queryContribs(zhapi, userData.techeditor.join('|'), '10|828', time[180]),
				queryContribs(cmapi, userData.techeditor.join('|'), '10|828', time[180]),
			]).then((result) => result.flat()),
			Promise.all([
				queryContribs(zhapi, userData.scripteditor.join('|'), '10|828|274', time[90]),
				queryContribs(cmapi, userData.scripteditor.join('|'), '10|828|274', time[90]),
			]).then((result) => result.flat()),
			Promise.all([
				queryContribs(zhapi, userData['interface-admin'].join('|'), '10|828|8', time[90]),
				queryContribs(cmapi, userData['interface-admin'].join('|'), '10|828|8', time[90]),
			]).then((result) => result.flat()),
		];
		const data = {};
		await Promise.all(processData).then((results) => {
			data.techeditor = results[0];
			data.scripteditor = results[1];
			data['interface-admin'] = results[2];
		});

		let text = '* 本页面为[[U:星海-interfacebot|机器人]]生成的技术人员90日或180日内中文萌娘百科与萌娘共享模板、模块和特定名字名字空间编辑数统计与特定名字空间365日内最后一次编辑时间。\n* 界面管理员的特定名字空间为「MediaWiki」（含[[GHIA:|GHIA]]），脚本编辑员的特定名字空间为「Widget」。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}\n<div style="display: flex; flex-wrap: wrap; justify-content: center;">\n<div style="width: 100%; max-width: 600px; margin:0 3rem 1rem">\n{| class="wikitable sortable" width=100%\n|+ 界面管理员\n|-\n! 用户名 !! 90日编辑数 !! MediaWiki最后编辑时间 \n';

		for (const user of userData['interface-admin']) {
			const contribsData = data['interface-admin'] && data['interface-admin'].filter((item) => item.user === user) || [];
			const nsContribsData = contribsData && contribsData.filter((item) => item.ns === 8) || [];

			const { [`U:${user}`]: ghiaUserData } = ghiaData;
			const ghiaContribsCount = ghiaUserData && ghiaUserData.filter((item) => moment(item.datetime).isAfter(moment(time[90]))).reduce((total, item) => total + item.changedFiles, 0) || 0;

			const contribsCount = contribsData.length + ghiaContribsCount;
			const count = contribsCount 
				? contribsCount >= 3
					? `data-sort-value="${contribsCount}"|${contribsCount}次`
					: `data-sort-value="${contribsCount}"|<span style="color:red">${contribsCount}次</span>`
				: 'data-sort-value="0"|<i style="color:red">无相关编辑</i>';

			if (nsContribsData.length || ghiaContribsCount) {
				const nsLatestTimestamp = nsContribsData.length && moment.max(nsContribsData.map((item) => moment(item.timestamp)));
				const ghiaLatestTimestamp = ghiaUserData?.length && moment.max(ghiaUserData.map((item) => moment(item.datetime))) || 0;
				const latestTimestamp = moment.max([ nsLatestTimestamp, ghiaLatestTimestamp ]);
				const timestamp = timestampCST(latestTimestamp);
				text += `|-\n| ${userInfo(user)} || ${count} || ${timestamp}\n`;
			} else {
				const moreContribs = await Promise.all([
					queryLatestContribs(zhapi, user, '8', time[365]),
					queryLatestContribs(cmapi, user, '8', time[365]),
				]).then((result) => result.flat().filter((item) => item !== undefined));
				const nsLatestTimestamp = moreContribs.length && moment.max(moreContribs.map((item) => moment(item)));
				
				const ghiaTimestamp = ghiaUserData && moment.max(ghiaUserData.map((item) => moment(item.datetime)));
				const ghiaLatestTimestamp = ghiaTimestamp?.isAfter(moment(time[365])) && ghiaTimestamp;

				const latestTimestamp = nsLatestTimestamp && ghiaLatestTimestamp
					? moment.max([ nsLatestTimestamp, ghiaLatestTimestamp ])
					: nsLatestTimestamp || ghiaLatestTimestamp;
				const timestamp = latestTimestamp
					? timestampCST(latestTimestamp)
					: '<i style="color:red">无相关编辑</i>';
				text += `|-\n| ${userInfo(user)} || ${count} || ${timestamp}\n`;
			}
		}

		text += '|}\n</div>\n<div style="width: 100%; max-width: 600px; margin:0 3rem 1rem">\n{| class="wikitable sortable" width=100%\n|+ 脚本编辑员\n|-\n! 用户名 !! 90日编辑数 !! Widget最后编辑时间 \n';

		for (const user of userData.scripteditor) {
			const contribsData = data.scripteditor && data.scripteditor.filter((item) => item.user === user) || [];
			const nsContribsData = contribsData && contribsData.filter((item) => item.ns === 8) || [];
			const contribsCount = contribsData.length;

			const count = contribsCount 
				? contribsCount >= 3
					? `data-sort-value="${contribsCount}"|${contribsCount}次`
					: `data-sort-value="${contribsCount}"|<span style="color:red">${contribsCount}次</span>`
				: 'data-sort-value="0"|<i style="color:red">无相关编辑</i>';
            
			if (nsContribsData.length) {
				const latestTimestamp = moment.max(nsContribsData.map((item) => moment(item.timestamp)));
				const timestamp = timestampCST(latestTimestamp);
				text += `|-\n| ${userInfo(user)} || ${count} || ${timestamp}\n`;
			} else {
				const moreContribs = await Promise.all([
					queryLatestContribs(zhapi, user, '274', time[365]),
					queryLatestContribs(cmapi, user, '274', time[365]),
				]).then((result) => result.flat().filter((item) => item !== undefined));
				const latestTimestamp = moreContribs.length && moment.max(moreContribs.map((item) => moment(item)));
				const timestamp = latestTimestamp
					? timestampCST(latestTimestamp)
					: '<i style="color:red">无相关编辑</i>';
				text += `|-\n| ${userInfo(user)} || ${count} || ${timestamp}\n`;
			}
		}

		text += '|}\n</div>\n<div style="width: 100%; max-width: 600px; margin:0 3rem 1rem">\n{| class="wikitable sortable" width=100%\n|+ 技术编辑员\n|-\n! 用户名 !! 180日编辑数 !! 最后编辑时间\n';

		for (const user of userData.techeditor) {
			const contribsData = data.techeditor && data.techeditor.filter((item) => item.user === user) || [];
			const contribsCount = contribsData.length;
			const count = contribsCount 
				? contribsCount >= 3
					? `data-sort-value="${contribsCount}"|${contribsCount}次`
					: `data-sort-value="${contribsCount}"|<span style="color:red">${contribsCount}次</span>`
				: 'data-sort-value="0"|<i style="color:red">无相关编辑</i>';
			const timestamp = contribsCount
				? timestampCST(moment.max(contribsData.map((item) => moment(item.timestamp))))
				: '<i style="color:red">无相关编辑</i>';
			text += `|-\n| ${userInfo(user)} || ${count} || ${timestamp}\n`;
		}

		text += '|}\n</div>\n</div>\n\n[[Category:萌娘百科数据报告]]';

		await updateData('540046', text);
	};

	const botTable = async () => {
		let text = '* 本页面为[[U:星海-interfacebot|机器人]]生成的机器人90日内最后活跃时间。\n* 只统计带有<code>Bot</code>标签的贡献和公开日志。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}\n<div style="display: flex; flex-wrap: wrap; justify-content: center;">\n<div style="width: 100%; margin:0 3rem 1rem">\n{| class="wikitable sortable" width=100%\n|-\n!rowspan=2 | 用户名 || colspan=2 | 主站 || colspan=2 | 共享站\n|-\n! 最后编辑时间 !! 最后日志时间 !! 最后编辑时间 !! 最后日志时间\n';

		for (const user of userData.bot) {
			const timestamp = (await Promise.all([
				queryLatestEvents(zhapi, user, time[90]),
				queryLatestEvents(cmapi, user, time[90]),
			])).join('');
			text += `|-\n| ${userInfo(user)} ${timestamp}\n`;
		}

		text += '|}\n</div>\n</div>\n\n[[Category:萌娘百科数据报告]]';
		
		await updateData('540047', text);
	};

	await Promise.all([
		maintainTable(),
		techTable(),
		botTable(),
	]);

	console.log(`End time: ${new Date().toISOString()}`);
})();
