import axios from 'axios';
import axiosRetry from 'axios-retry';
import moment from 'moment';
import type { MediaWikiApi, MwApiParams } from 'wiki-saikou';
import mapLimit from '../common/concurrency.ts';
import paginate from '../core/paginate.ts';
import { safePostWithToken } from '../core/retry.ts';

const GHIA_HISTORY_URL = 'https://raw.githubusercontent.com/MoegirlPediaInterfaceAdmins/MoegirlPediaInterfaceCodes/master/src/global/zh/GHIAHistory.json';
const NO_EDIT_HTML = '<i style="color:red">无相关编辑</i>';

const now = moment().utc();
export const maintainerTime = {
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
export const timestampCST = (timestamp: string | number | moment.Moment): string => `${moment(timestamp).utcOffset('+08:00').format('YYYY-MM-DD HH:mm:ss')} (CST)`;
export const userInfo = (user: string): string => `{{#Avatar:${user}|class=userlink-avatar-small}}{{User|${user}}}`;

export const maxMoment = (dates: Array<string | number | moment.Moment | false | null | undefined>): moment.Moment | null => {
	const valid = dates
		.filter((d): d is string | number | moment.Moment => d !== null && d !== undefined && d !== false && d !== 0)
		.map((d) => moment(d))
		.filter((m) => m.isValid());
	return valid.length ? moment.max(valid) : null;
};

export interface MaintainerQueryResponse {
	query?: {
		pages?: Array<{ revisions?: Array<{ content?: string }> }>;
		allusers?: Array<{ name: string }>;
		usercontribs?: Array<{ timestamp: string }>;
		logevents?: Array<{ timestamp: string }>;
	};
}

export const safeMaintainerPost = async (api: MediaWikiApi, params: MwApiParams, attempts = 5): Promise<{ data: MaintainerQueryResponse }> => {
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

export const queryContribs = async (
	api: MediaWikiApi,
	users: string[],
	ucnamespace: string,
	ucend: string,
): Promise<Array<{ user: string; title: string; timestamp: string; ns?: number }>> => {
	if (!users?.length) {
		return [];
	}
	const chunks: string[][] = [];
	for (let i = 0; i < users.length; i += 15) {
		chunks.push(users.slice(i, i + 15));
	}
	const chunkResults = await mapLimit(chunks, 2, async (userChunk) => {
		const result = [];
		for await (const data of paginate(api, {
			list: 'usercontribs',
			uclimit: 'max',
			ucstart: maintainerTime[0],
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
		const { data } = await safeMaintainerPost(api, {
			list: 'usercontribs',
			uclimit: '1',
			ucstart: maintainerTime[0],
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

export const queryLatestEvents = async (api: MediaWikiApi, user: string, end: string, isCm: boolean): Promise<string> => {
	try {
		const { data } = await safeMaintainerPost(api, {
			list: 'usercontribs|logevents',
			uclimit: '1',
			lelimit: '1',
			ucstart: maintainerTime[0],
			lestart: maintainerTime[0],
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
		const logeventsTimestamp = logevents.length ? timestampCST(logevents[0].timestamp) : '-';
		return `|| ${contribsTimestamp} || ${logeventsTimestamp} `;
	} catch (err) {
		console.warn(`queryLatestEvents failed for ${user}:`, err instanceof Error ? err.message : String(err));
		return '|| - || - ';
	}
};

export const fetchGhiaHistory = async (): Promise<Record<string, unknown>> => {
	try {
		const { data } = await axios.get(GHIA_HISTORY_URL, { timeout: 15000 });
		return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
	} catch (err) {
		console.warn('Failed to fetch GHIAHistory.json, continuing without GHIA data:', err instanceof Error ? err.message : String(err));
		return {};
	}
};

export const updateMaintainerPage = async (zhapi: MediaWikiApi, pageid: string, text: string): Promise<void> => {
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
	}, { retry: 50, noCache: true });
};

const formatContribCount = (contribsCount: number, minCount: number): string => {
	if (!contribsCount) {
		return `data-sort-value="0"|${NO_EDIT_HTML}`;
	}
	return contribsCount >= minCount
		? `data-sort-value="${contribsCount}"|${contribsCount}次`
		: `data-sort-value="${contribsCount}"|<span style="color:red">${contribsCount}次</span>`;
};

export const renderContribRows = (
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

export const renderInterfaceAdminRow = async (
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
		.filter((item) => moment(item.datetime).isAfter(moment(maintainerTime[180])))
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
			queryLatestContribs(zhapi, user, '8|274', maintainerTime[365]),
			queryLatestContribs(cmapi, user, '8|274', maintainerTime[365]),
		]).then((result) => result.flat().filter((item) => item !== undefined));
		const ghiaTimestamp = maxMoment(ghiaEntries.map((item) => item.datetime));
		latestTimestamp = maxMoment([
			maxMoment(moreContribs),
			ghiaTimestamp?.isAfter(moment(maintainerTime[365])) ? ghiaTimestamp : null,
		]);
	}

	const timestamp = latestTimestamp ? timestampCST(latestTimestamp) : NO_EDIT_HTML;
	return `|-\n| ${userInfo(user)} || ${count} || ${timestamp}\n`;
};
