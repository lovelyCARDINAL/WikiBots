import process from 'process';
import mapLimit from '../utils/common/concurrency.ts';
import { createAndLogin } from '../utils/core/createApi.ts';
import {
	fetchGhiaHistory,
	maintainerTime,
	queryContribs,
	queryLatestEvents,
	renderContribRows,
	renderInterfaceAdminRow,
	safeMaintainerPost,
	updateMaintainerPage,
	userInfo,
} from '../utils/report/maintainerHelper.ts';

const FILTER_BOTS = new Set(['滥用过滤器', 'Abuse filter', '不正利用フィルター', 'Delete page script', '重定向修复器', '萌娘百科·注销管理员']);

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	const [zhapi, cmapi] = await Promise.all([
		createAndLogin('zh', 'ibot'),
		createAndLogin('cm', 'ibot'),
	]);

	const userData = await (async () => {
		const [{ data: moduleData }, { data: botsData }] = await Promise.all([
			safeMaintainerPost(zhapi, { prop: 'revisions', titles: 'Module:UserGroup/data', rvprop: 'content' }),
			safeMaintainerPost(zhapi, { list: 'allusers', augroup: 'bot', aulimit: 'max' }),
		]);
		const content = moduleData?.query?.pages?.[0]?.revisions?.[0]?.content;
		if (!content) {
			throw new Error('Failed to load Module:UserGroup/data');
		}
		const data = JSON.parse(content) as Record<string, string[]>;
		const allusers = botsData?.query?.allusers || [];
		data.bot = allusers.filter((user) => !FILTER_BOTS.has(user.name)).map((user) => user.name);
		return data;
	})();

	const maintainTable = async () => {
		const sysopUsers = Array.isArray(userData.sysop) ? userData.sysop : [];
		const patrollerUsers = Array.isArray(userData.patroller) ? userData.patroller : [];
		const [sysop, patroller] = await Promise.all([
			Promise.all([
				queryContribs(zhapi, sysopUsers, '0|10|14|12|4|6', maintainerTime[30]),
				queryContribs(cmapi, sysopUsers, '0|10|14|12|4|6', maintainerTime[30]),
			]),
			Promise.all([
				queryContribs(zhapi, patrollerUsers, '0|10|14|12|4|6', maintainerTime[60]),
				queryContribs(cmapi, patrollerUsers, '0|10|14|12|4|6', maintainerTime[60]),
			]),
		]);

		let text = '* 本页面为[[U:星海-interfacebot|机器人]]生成的维护人员有效编辑数统计。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}\n<div style="display: flex; flex-wrap: wrap; justify-content: center;">\n<div style="width: 100%; max-width: 600px; margin:0 3rem 1rem">\n{| class="wikitable sortable" width=100%\n|+ 管理员\n|-\n! 用户名 !! 30日编辑数 !! 最后编辑时间\n';
		text += renderContribRows(sysopUsers, sysop.flat(), 3, true);
		text += '|}\n</div>\n<div style="width: 100%; max-width: 600px; margin:0 3rem 1rem">\n{| class="wikitable sortable" width=100%\n|+ 维护姬\n|-\n! 用户名 !! 60日编辑数 !! 最后编辑时间\n';
		text += renderContribRows(patrollerUsers, patroller.flat(), 5, true);
		text += '|}\n</div>\n</div>\n\n[[Category:萌娘百科数据报告]]';

		await updateMaintainerPage(zhapi, '540045', text);
	};

	const techTable = async () => {
		const techeditorUsers = Array.isArray(userData.techeditor) ? userData.techeditor : [];
		const interfaceAdminUsers = Array.isArray(userData['interface-admin']) ? userData['interface-admin'] : [];
		const [ghiaData, techeditor, interfaceAdmin] = await Promise.all([
			fetchGhiaHistory(),
			Promise.all([
				queryContribs(zhapi, techeditorUsers, '10|828', maintainerTime[365]),
				queryContribs(cmapi, techeditorUsers, '10|828', maintainerTime[365]),
			]),
			Promise.all([
				queryContribs(zhapi, interfaceAdminUsers, '10|828|8|274', maintainerTime[180]),
				queryContribs(cmapi, interfaceAdminUsers, '10|828|8|274', maintainerTime[180]),
			]),
		]);

		const interfaceRows = await Promise.all(
			interfaceAdminUsers.map((user) => renderInterfaceAdminRow(user, interfaceAdmin.flat(), ghiaData, zhapi, cmapi)),
		);

		let text = '* 本页面为[[U:星海-interfacebot|机器人]]生成的技术人员有效编辑数统计与特定命名空间最后编辑时间。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}\n<div style="display: flex; flex-wrap: wrap; justify-content: center;">\n<div style="width: 100%; max-width: 600px; margin:0 3rem 1rem">\n{| class="wikitable sortable" width=100%\n|+ 界面管理员\n|-\n! 用户名 !! 180日编辑数 !! MediaWiki或Widget最后编辑时间 \n';
		text += interfaceRows.join('');
		text += '|}\n</div>\n<div style="width: 100%; max-width: 600px; margin:0 3rem 1rem">\n{| class="wikitable sortable" width=100%\n|+ 技术编辑员\n|-\n! 用户名 !! 365日编辑数 !! 最后编辑时间\n';
		text += renderContribRows(techeditorUsers, techeditor.flat(), 3);
		text += '|}\n</div>\n</div>\n\n[[Category:萌娘百科数据报告]]';

		await updateMaintainerPage(zhapi, '540046', text);
	};

	const botTable = async () => {
		let text = '* 本页面为[[U:星海-interfacebot|机器人]]生成的机器人90日内最后活跃时间。\n* 只统计带有<code>Bot</code>标签的贡献和公开日志。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}\n<div style="display: flex; flex-wrap: wrap; justify-content: center;">\n<div style="width: 100%; margin:0 3rem 1rem">\n{| class="wikitable sortable" width=100%\n|-\n!rowspan=2 | 用户名 || colspan=2 | 主站 || colspan=2 | 共享站\n|-\n! 最后编辑时间 !! 最后日志时间 !! 最后编辑时间 !! 最后日志时间\n';

		const rows = await mapLimit(userData.bot, 4, async (user) => {
			const [zhEvents, cmEvents] = await Promise.all([
				queryLatestEvents(zhapi, user, maintainerTime[90], false),
				queryLatestEvents(cmapi, user, maintainerTime[90], true),
			]);
			return `|-\n| ${userInfo(user)} ${zhEvents}${cmEvents}\n`;
		});

		text += `${rows.join('')}|}\n</div>\n</div>\n\n[[Category:萌娘百科数据报告]]`;

		await updateMaintainerPage(zhapi, '540047', text);
	};

	const tasks = [
		{ name: 'maintainTable', fn: maintainTable },
		{ name: 'techTable', fn: techTable },
		{ name: 'botTable', fn: botTable },
	];
	let failures = 0;
	for (const { name, fn } of tasks) {
		try {
			await fn();
		} catch (err) {
			failures++;
			console.error(`${name} failed:`, err instanceof Error ? err.message : String(err));
		}
	}

	if (failures > 0) {
		throw new Error(`${failures}/${tasks.length} maintainer task(s) failed`);
	}

	console.log(`End time: ${new Date().toISOString()}`);
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
