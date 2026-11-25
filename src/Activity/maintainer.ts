import axios from 'axios';
import axiosRetry from 'axios-retry';
import moment from 'moment';
import type { MediaWikiApi, MwApiParams } from 'wiki-saikou';
import mapLimit from '../utils/common/concurrency.ts';
import { createAndLogin } from '../utils/core/createApi.ts';
import paginate from '../utils/core/paginate.ts';
import { safePostWithToken } from '../utils/core/retry.ts';

const GHIA_HISTORY_URL = 'https://raw.githubusercontent.com/MoegirlPediaInterfaceAdmins/MoegirlPediaInterfaceCodes/master/src/global/zh/GHIAHistory.json';
const FILTER_BOTS = new Set(['滥用过滤器', 'Abuse filter', '不正利用フィルター', 'Delete page script', '重定向修复器', '萌娘百科·注销管理员']);
const NO_EDIT_HTML = '<i style="color:red">无相关编辑</i>';

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
	retryDelay: (retryCount) => retryCount * 1000,
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const timestampCST = (timestamp: string | number | moment.Moment): string => `${moment(timestamp).utcOffset('+08:00').format('YYYY-MM-DD HH:mm:ss')} (CST)`;

/**
 * Safely compute the latest valid moment from an array of date inputs.
 * Returns null when no valid dates are provided.
 */
const maxMoment = (dates: Array<string | number | moment.Moment | false | null | undefined>): moment.Moment | null => {
	const valid = dates
		.filter((d): d is string | number | moment.Moment => d !== null && d !== undefined && d !== false && d !== 0)
		.map((d) => moment(d))
		.filter((m) => m.isValid());
	return valid.length ? moment.max(valid) : null;
};

/**
 * Robust MediaWiki POST wrapper with exponential backoff on gateway/network glitches
 * or missing `data.query`.
 */
interface MaintainerQueryResponse {
	query?: {
		pages?: Array<{ revisions?: Array<{ content?: string }> }>;
		allusers?: Array<{ name: string }>;
		usercontribs?: Array<{ timestamp: string }>;
		logevents?: Array<{ timestamp: string }>;
	};
}

const safePost = async (api: MediaWikiApi, params: MwApiParams, attempts = 5): Promise<{ data: MaintainerQueryResponse }> => {
	let lastErr: unknown;
	for (let i = 1; i <= attempts; i++) {
		try {
			const res = await api.post(params, { retry: 10 });
			if (res?.data?.query) {
				return res;
			}
			throw new Error(`Missing query in API response: ${JSON.stringify(res?.data)?.slice(0, 200)}`);
		} catch (err) {
			lastErr = err;
			if (i < attempts) {
				const delay = Math.min(30000, 1000 * 2 ** (i - 1)) + Math.floor(Math.random() * 500);
				console.warn(`API request failed (attempt ${i}/${attempts}), retrying in ${delay}ms:`, err instanceof Error ? err.message : String(err));
				await sleep(delay);
			}
		}
	}
	throw lastErr;
};

/**
 * Query usercontribs in chunks of users so large user lists don't trigger 503/504 timeouts,
 * preserving full `data.continue` pagination.
 */
const queryContribs = async (
	api: MediaWikiApi,
	users: string[],
	ucnamespace: string,
	ucend: string,
): Promise<Array<{ user: string; title: string; timestamp: string; ns?: number }>> => {
	if (!users?.length) {
		return [];
	}
	const chunkSize = 15;
	const chunks = [];
	for (let i = 0; i < users.length; i += chunkSize) {
		chunks.push(users.slice(i, i + chunkSize));
	}

	const chunkResults = await mapLimit(chunks, 2, async (userChunk) => {
		const result = [];
		for await (const data of paginate(api, {
			list: 'usercontribs',
			uclimit: 'max',
			ucstart: time[0],
			ucend,
			ucnamespace,
			ucuser: userChunk,
			ucprop: 'title|timestamp',
		}, { retry: 15 })) {
			if (data?.query?.usercontribs) {
				result.push(...data.query.usercontribs);
			}
		}
		return result;
	});
	return chunkResults.flat();
};

const queryLatestContribs = async (api: MediaWikiApi, ucuser: string, ucnamespace: string, ucend: string): Promise<string | undefined> => {
	try {
		const { data } = await safePost(api, {
			list: 'usercontribs',
			uclimit: '1',
			ucstart: time[0],
			ucend,
			ucnamespace,
			ucuser,
			ucprop: 'timestamp',
		});
		return data?.query?.usercontribs?.[0]?.timestamp;
	} catch (err) {
		console.warn(`queryLatestContribs failed for ${ucuser}:`, err instanceof Error ? err.message : String(err));
		return undefined;
	}
};

const queryLatestEvents = async (api: MediaWikiApi, user: string, end: string, isCm: boolean): Promise<string> => {
	try {
		const { data } = await safePost(api, {
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
		});
		const usercontribs = data?.query?.usercontribs || [];
		const logevents = data?.query?.logevents || [];
		const contribsTimestamp = usercontribs.length
			? timestampCST(usercontribs[0].timestamp)
			: isCm || ['AnnAngela-bbot', 'AnnAngela-cbot', '星海-oversightbot', '星海-userrightsbot', '萌百娘', 'SILI bot'].includes(user)
				? '-'
				: NO_EDIT_HTML;
		const logeventsTimestamp = logevents.length
			? timestampCST(logevents[0].timestamp)
			: '-';
		return `|| ${contribsTimestamp} || ${logeventsTimestamp} `;
	} catch (err) {
		console.warn(`queryLatestEvents failed for ${user}:`, err instanceof Error ? err.message : String(err));
		return '|| - || - ';
	}
};

const fetchGhiaHistory = async (): Promise<Record<string, unknown>> => {
	try {
		const { data } = await axios.get(GHIA_HISTORY_URL, { timeout: 15000 });
		return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
	} catch (err) {
		console.warn('Failed to fetch GHIAHistory.json, continuing without GHIA data:', err instanceof Error ? err.message : String(err));
		return {};
	}
};

const updateData = async (zhapi: MediaWikiApi, pageid: string, text: string): Promise<void> => {
	await safePostWithToken(zhapi, 'csrf', {
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
	});
};

const userInfo = (user: string): string => `{{#Avatar:${user}|class=userlink-avatar-small}}{{User|${user}}}`;

const formatContribCount = (contribsCount: number, minCount: number): string => {
	if (!contribsCount) {
		return `data-sort-value="0"|${NO_EDIT_HTML}`;
	}
	return contribsCount >= minCount
		? `data-sort-value="${contribsCount}"|${contribsCount}次`
		: `data-sort-value="${contribsCount}"|<span style="color:red">${contribsCount}次</span>`;
};

const renderContribRows = (
	users: string[],
	contribsList: Array<{ user: string; title: string; timestamp: string }>,
	minCount: number,
	excludeSandbox = false,
): string => users.map((user) => {
	const contribsData = contribsList.filter((item) => item.user === user && (!excludeSandbox || !/Sandbox|测试|沙盒/i.test(item.title)));
	const count = formatContribCount(contribsData.length, minCount);
	const latest = maxMoment(contribsData.map((item) => item.timestamp));
	const timestamp = latest ? timestampCST(latest) : NO_EDIT_HTML;
	return `|-\n| ${userInfo(user)} || ${count} || ${timestamp}\n`;
}).join('');

interface GhiaEntry {
	datetime?: string;
	changedFiles?: number;
}

const renderInterfaceAdminRow = async (
	user: string,
	contribsList: Array<{ user: string; title: string; timestamp: string; ns?: number }>,
	ghiaData: Record<string, unknown>,
	zhapi: MediaWikiApi,
	cmapi: MediaWikiApi,
): Promise<string> => {
	const contribsData = contribsList.filter((item) => item.user === user);
	const nsContribsData = contribsData.filter((item) => item.ns === 8 || item.ns === 274);
	const ghiaUserData = ghiaData[`U:${user}`];
	const ghiaEntries = Array.isArray(ghiaUserData) ? (ghiaUserData as GhiaEntry[]) : [];
	const ghiaContribsCount = ghiaEntries
		.filter((item) => moment(item.datetime).isAfter(moment(time[180])))
		.reduce((total, item) => total + (item.changedFiles || 0), 0);

	const count = formatContribCount(contribsData.length + ghiaContribsCount, 3);
	let latestTimestamp: moment.Moment | null;

	if (nsContribsData.length || ghiaContribsCount) {
		latestTimestamp = maxMoment([
			maxMoment(nsContribsData.map((item) => item.timestamp)),
			maxMoment(ghiaEntries.map((item) => item.datetime)),
		]);
	} else {
		const moreContribs = await Promise.all([
			queryLatestContribs(zhapi, user, '8|274', time[365]),
			queryLatestContribs(cmapi, user, '8|274', time[365]),
		]).then((result) => result.flat().filter((item) => item !== undefined));
		const ghiaTimestamp = maxMoment(ghiaEntries.map((item) => item.datetime));
		latestTimestamp = maxMoment([
			maxMoment(moreContribs),
			ghiaTimestamp?.isAfter(moment(time[365])) ? ghiaTimestamp : null,
		]);
	}

	const timestamp = latestTimestamp ? timestampCST(latestTimestamp) : NO_EDIT_HTML;
	return `|-\n| ${userInfo(user)} || ${count} || ${timestamp}\n`;
};

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	const [zhapi, cmapi] = await Promise.all([
		createAndLogin('zh', 'ibot'),
		createAndLogin('cm', 'ibot'),
	]);

	const userData = await (async () => {
		const [{ data: moduleData }, { data: botsData }] = await Promise.all([
			safePost(zhapi, {
				prop: 'revisions',
				titles: 'Module:UserGroup/data',
				rvprop: 'content',
			}),
			safePost(zhapi, {
				list: 'allusers',
				augroup: 'bot',
				aulimit: 'max',
			}),
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
				queryContribs(zhapi, sysopUsers, '0|10|14|12|4|6', time[30]),
				queryContribs(cmapi, sysopUsers, '0|10|14|12|4|6', time[30]),
			]),
			Promise.all([
				queryContribs(zhapi, patrollerUsers, '0|10|14|12|4|6', time[60]),
				queryContribs(cmapi, patrollerUsers, '0|10|14|12|4|6', time[60]),
			]),
		]);

		let text = '* 本页面为[[U:星海-interfacebot|机器人]]生成的维护人员有效编辑数统计。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}\n<div style="display: flex; flex-wrap: wrap; justify-content: center;">\n<div style="width: 100%; max-width: 600px; margin:0 3rem 1rem">\n{| class="wikitable sortable" width=100%\n|+ 管理员\n|-\n! 用户名 !! 30日编辑数 !! 最后编辑时间\n';
		text += renderContribRows(sysopUsers, sysop.flat(), 3, true);
		text += '|}\n</div>\n<div style="width: 100%; max-width: 600px; margin:0 3rem 1rem">\n{| class="wikitable sortable" width=100%\n|+ 维护姬\n|-\n! 用户名 !! 60日编辑数 !! 最后编辑时间\n';
		text += renderContribRows(patrollerUsers, patroller.flat(), 5, true);
		text += '|}\n</div>\n</div>\n\n[[Category:萌娘百科数据报告]]';

		await updateData(zhapi, '540045', text);
	};

	const techTable = async () => {
		const techeditorUsers = Array.isArray(userData.techeditor) ? userData.techeditor : [];
		const interfaceAdminUsers = Array.isArray(userData['interface-admin']) ? userData['interface-admin'] : [];
		const [ghiaData, techeditor, interfaceAdmin] = await Promise.all([
			fetchGhiaHistory(),
			Promise.all([
				queryContribs(zhapi, techeditorUsers, '10|828', time[365]),
				queryContribs(cmapi, techeditorUsers, '10|828', time[365]),
			]),
			Promise.all([
				queryContribs(zhapi, interfaceAdminUsers, '10|828|8|274', time[180]),
				queryContribs(cmapi, interfaceAdminUsers, '10|828|8|274', time[180]),
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

		await updateData(zhapi, '540046', text);
	};

	const botTable = async () => {
		let text = '* 本页面为[[U:星海-interfacebot|机器人]]生成的机器人90日内最后活跃时间。\n* 只统计带有<code>Bot</code>标签的贡献和公开日志。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}\n<div style="display: flex; flex-wrap: wrap; justify-content: center;">\n<div style="width: 100%; margin:0 3rem 1rem">\n{| class="wikitable sortable" width=100%\n|-\n!rowspan=2 | 用户名 || colspan=2 | 主站 || colspan=2 | 共享站\n|-\n! 最后编辑时间 !! 最后日志时间 !! 最后编辑时间 !! 最后日志时间\n';

		const rows = await mapLimit(userData.bot, 4, async (user) => {
			const [zhEvents, cmEvents] = await Promise.all([
				queryLatestEvents(zhapi, user, time[90], false),
				queryLatestEvents(cmapi, user, time[90], true),
			]);
			return `|-\n| ${userInfo(user)} ${zhEvents}${cmEvents}\n`;
		});

		text += `${rows.join('')}|}\n</div>\n</div>\n\n[[Category:萌娘百科数据报告]]`;

		await updateData(zhapi, '540047', text);
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
