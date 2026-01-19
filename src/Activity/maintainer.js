import axios from 'axios';
import axiosRetry from 'axios-retry';
import moment from 'moment';
import { MediaWikiApi } from 'wiki-saikou';
import config from '../utils/config.js';

const zhapi = new MediaWikiApi(config.zh.api, {
		headers: { 'user-agent': config.useragent },
	}),
	cmapi = new MediaWikiApi(config.cm.api, {
		headers: { 'user-agent': config.useragent },
	});

const now = moment().utc();
const time = {
	0: now.toISOString(),
	30: now.subtract(30, 'days').toISOString(),
	60: now.subtract(30, 'days').toISOString(),
	90: now.subtract(30, 'days').toISOString(),
	180: now.subtract(90, 'days').toISOString(),
	365: now.subtract(185, 'days').toISOString(),
};

axiosRetry(axios, {
	retries: 5,
	retryDelay: (retryCount) => {
		return retryCount * 1000;
	},
});

const timestampCST = (timestamp) => {
	return `${moment(timestamp).utcOffset('+08:00').format('YYYY-MM-DD HH:mm:ss')} (CST)`;
};

const queryContribs = async (api, ucuser, ucnamespace, ucend) => {
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
			uccontinue,
		}, {
			retry: 15,
		});
		uccontinue = data.continue ? data.continue.uccontinue : eol;
		result.push(...data.query.usercontribs);
	}
	return result;
};

const queryLatestContribs = async (api, ucuser, ucnamespace, ucend) => {
	const { data: { query: { usercontribs } } } = await api.post({
		list: 'usercontribs',
		uclimit: '1',
		ucstart: time[0],
		ucend,
		ucnamespace,
		ucuser,
		ucprop: 'timestamp',
	}, {
		retry: 15,
	});
	return usercontribs?.[0]?.timestamp;
};

const queryLatestEvents = async (api, user, end) => {
	const { data: { query: { usercontribs, logevents } } } = await api.post({
		list: 'usercontribs|logevents',
		uclimit: '1',
		lelimit: '1',
		ucstart: time[0],
		lestart: time[0],
		ucend: end,
		leend: end,
		ucnamespace: '*',
		ucuser: user,
		leuser: user,
		ucprop: 'timestamp',
		leprop: 'timestamp',
		uctag: 'Bot',
		letag: 'Bot',
	}, {
		retry: 15,
	});
	const contribsTimestamp = usercontribs.length
		? timestampCST(usercontribs[0].timestamp)
		: api === cmapi || ['AnnAngela-cbot', '星海-oversightbot', '萌百娘'].includes(user)
			? '-'
			: '<i style="color:red">无相关编辑</i>';
	const logeventsTimestamp = logevents.length
		? timestampCST(logevents[0].timestamp)
		: '-';
	return `|| ${contribsTimestamp} || ${logeventsTimestamp} `;
};

const updateData = async (pageid, text) => {
	await zhapi.postWithToken('csrf', {
		action: 'edit',
		pageid,
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
};

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
	
	const userData = await (async () => {
		const [{ data: { query: { pages: [{ revisions: [{ content }] }] } } },
			{ data: { query: { allusers } } }] = await Promise.all([
			zhapi.post({
				prop: 'revisions',
				titles: 'Module:UserGroup/data',
				rvprop: 'content',
			}, {
				retry: 15,
			}),
			zhapi.post({
				list: 'allusers',
				augroup: 'bot',
				aulimit: 'max',
			}, {
				retry: 15,
			}),
		]);
		const data = JSON.parse(content);
		const filterBots = ['滥用过滤器', 'Abuse filter', '不正利用フィルター', 'Delete page script', '重定向修复器'];
		data.bot = allusers.filter((user) => !filterBots.includes(user.name)).map((user) => user.name);
		return data;
	})();

	const userInfo = (user) => {
    	return `{{#Avatar:${user}|class=userlink-avatar-small}}{{User|${user}}}`;
	};

	const maintainTable = async () => {
		const [sysop, patroller] = await Promise.all([
			Promise.all([
				queryContribs(zhapi, userData.sysop, '0|10|14|12|4|6', time[30]),
				queryContribs(cmapi, userData.sysop, '0|10|14|12|4|6', time[30]),
			]),
			Promise.all([
				queryContribs(zhapi, userData.patroller, '0|10|14|12|4|6', time[60]),
				queryContribs(cmapi, userData.patroller, '0|10|14|12|4|6', time[60]),
			]),
		]);
		const data = {
			sysop: sysop.flat(),
			patroller: patroller.flat(),
		};
	
		let text = '* 本页面为[[U:星海-interfacebot|机器人]]生成的维护人员有效编辑数统计。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}\n<div style="display: flex; flex-wrap: wrap; justify-content: center;">\n<div style="width: 100%; max-width: 600px; margin:0 3rem 1rem">\n{| class="wikitable sortable" width=100%\n|+ 管理员\n|-\n! 用户名 !! 30日编辑数 !! 最后编辑时间\n';
	
		const processUser = (group, minCount) => {
			for (const user of userData[group]) {
				const contribsData = data[group].filter((item) => item.user === user && !/Sandbox|测试|沙盒/i.test(item.title)) || [];
				const contribsCount = contribsData.length;
				const count = contribsCount 
					? contribsCount >= minCount
						? `data-sort-value="${contribsCount}"|${contribsCount}次`
						: `data-sort-value="${contribsCount}"|<span style="color:red">${contribsCount}次</span>`
					: 'data-sort-value="0"|<i style="color:red">无相关编辑</i>';
				const timestamp = contribsCount
					? timestampCST(moment.max(contribsData.map((item) => moment(item.timestamp))))
					: '<i style="color:red">无相关编辑</i>';
				text += `|-\n| ${userInfo(user)} || ${count} || ${timestamp}\n`;
			}
		};
	
		processUser('sysop', 3);

		text += '|}\n</div>\n<div style="width: 100%; max-width: 600px; margin:0 3rem 1rem">\n{| class="wikitable sortable" width=100%\n|+ 维护姬\n|-\n! 用户名 !! 60日编辑数 !! 最后编辑时间\n';

		processUser('patroller', 5);

		text += '|}\n</div>\n</div>\n\n[[Category:萌娘百科数据报告]]';
		
		await updateData('540045', text);
	};

	const techTable = async () => {
		const { data: ghiaData } = await axios.get('https://raw.githubusercontent.com/MoegirlPediaInterfaceAdmins/MoegirlPediaInterfaceCodes/master/src/global/zh/GHIAHistory.json');
		const [techeditor, interfaceAdmin] = await Promise.all([
			Promise.all([
				queryContribs(zhapi, userData.techeditor, '10|828', time[180]),
				queryContribs(cmapi, userData.techeditor, '10|828', time[180]),
			]),
			Promise.all([
				queryContribs(zhapi, userData['interface-admin'], '10|828|8|274', time[180]),
				queryContribs(cmapi, userData['interface-admin'], '10|828|8|274', time[180]),
			]),
		]);
		const data = {
			techeditor: techeditor.flat(),
			'interface-admin': interfaceAdmin.flat(),
		};

		let text = '* 本页面为[[U:星海-interfacebot|机器人]]生成的技术人员有效编辑数统计与特定命名空间最后编辑时间。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}\n<div style="display: flex; flex-wrap: wrap; justify-content: center;">\n<div style="width: 100%; max-width: 600px; margin:0 3rem 1rem">\n{| class="wikitable sortable" width=100%\n|+ 界面管理员\n|-\n! 用户名 !! 180日编辑数 !! MediaWiki或Widget最后编辑时间 \n';

		for (const user of userData['interface-admin']) {
			const contribsData = data['interface-admin'] && data['interface-admin'].filter((item) => item.user === user) || [];
			const nsContribsData = contribsData && contribsData.filter((item) => item.ns === 8 || item.ns === 274) || [];

			const { [`U:${user}`]: ghiaUserData } = ghiaData;
			const ghiaContribsCount = ghiaUserData && ghiaUserData.filter((item) => moment(item.datetime).isAfter(moment(time[180]))).reduce((total, item) => total + item.changedFiles, 0) || 0;

			const contribsCount = contribsData.length + ghiaContribsCount;
			const count = contribsCount 
				? contribsCount >= 3
					? `data-sort-value="${contribsCount}"|${contribsCount}次`
					: `data-sort-value="${contribsCount}"|<span style="color:red">${contribsCount}次</span>`
				: 'data-sort-value="0"|<i style="color:red">无相关编辑</i>';

			if (nsContribsData.length || ghiaContribsCount) {
				const nsLatestTimestamp = nsContribsData.length && moment.max(nsContribsData.map((item) => moment(item.timestamp)));
				const ghiaLatestTimestamp = ghiaUserData?.length && moment.max(ghiaUserData.map((item) => moment(item.datetime))) || 0;
				const latestTimestamp = moment.max([nsLatestTimestamp, ghiaLatestTimestamp]);
				const timestamp = timestampCST(latestTimestamp);
				text += `|-\n| ${userInfo(user)} || ${count} || ${timestamp}\n`;
			} else {
				const moreContribs = await Promise.all([
					queryLatestContribs(zhapi, user, '8|274', time[365]),
					queryLatestContribs(cmapi, user, '8|274', time[365]),
				]).then((result) => result.flat().filter((item) => item !== undefined));
				const nsLatestTimestamp = moreContribs.length && moment.max(moreContribs.map((item) => moment(item)));
				
				const ghiaTimestamp = ghiaUserData && moment.max(ghiaUserData.map((item) => moment(item.datetime)));
				const ghiaLatestTimestamp = ghiaTimestamp?.isAfter(moment(time[365])) && ghiaTimestamp;

				const latestTimestamp = nsLatestTimestamp && ghiaLatestTimestamp
					? moment.max([nsLatestTimestamp, ghiaLatestTimestamp])
					: nsLatestTimestamp || ghiaLatestTimestamp;
				const timestamp = latestTimestamp
					? timestampCST(latestTimestamp)
					: '<i style="color:red">无相关编辑</i>';
				text += `|-\n| ${userInfo(user)} || ${count} || ${timestamp}\n`;
			}
		}

		text += '|}\n</div>\n<div style="width: 100%; max-width: 600px; margin:0 3rem 1rem">\n{| class="wikitable sortable" width=100%\n|+ 技术编辑员\n|-\n! 用户名 !! 365日编辑数 !! 最后编辑时间\n';

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
