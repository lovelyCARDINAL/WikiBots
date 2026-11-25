import { MediaWikiApi } from 'wiki-saikou';
import { editTimeData, getTimeData } from '../utils/common/lastTime.ts';
import splitAndJoin from '../utils/common/splitAndJoin.ts';
import clientLogin from '../utils/core/clientLogin.ts';
import config from '../utils/core/config.ts';
import paginate from '../utils/core/paginate.ts';
import {
	deleteAvatar,
	hideAbuseLog,
	hidePages,
	queryLogs,
} from '../utils/wiki/suppressHelper.ts';

const zhapi = new MediaWikiApi({
	baseURL: config.zh.api,
	fexiosConfigs: { headers: { 'user-agent': config.useragent } },
});

const cmapi = new MediaWikiApi({
	baseURL: config.cm.api,
	fexiosConfigs: { headers: { 'user-agent': config.useragent } },
});

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	await Promise.all([
		clientLogin(zhapi, config.cm.sbot.account, config.password),
		clientLogin(cmapi, config.cm.sbot.account, config.password),
	]);

	const lastTime = await getTimeData('hide-user-log');
	const leend = lastTime['hide-user-log'],
		lestart = new Date().toISOString();

	const userlist = await Promise.all([
		queryLogs(zhapi, 'suppress/block', leend, lestart),
		queryLogs(zhapi, 'suppress/reblock', leend, lestart),
	]).then((result) => (result.flat() as string[]).map((title) => title.replace('User:', '')));

	await Promise.all(userlist.map((user) => Promise.all([
		hidePages(zhapi, user),
		hideAbuseLog(zhapi, user),
		deleteAvatar(cmapi, user),
	])));

	const idlist = await Promise.all([
		Promise.all(userlist.map(async (user) => {
			const result = [];
			for await (const data of paginate(cmapi, {
				list: 'logevents',
				leprop: 'ids',
				leuser: user.replace('User:', ''),
				lelimit: 'max',
			})) {
				if (data?.query?.logevents) {
					result.push(...data.query.logevents);
				}
			}
			return result
				.filter(({ suppressed }) => !suppressed)
				.map(({ logid }) => logid)
				.filter((id): id is number => typeof id === 'number');
		})),
		queryLogs(cmapi, 'avatar/delete', new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()),
	]).then((result) => result.flat(2) as Array<string | number>);

	await Promise.all(splitAndJoin(idlist, 500).map(async (ids) => {
		try {
			const { data } = await cmapi.postWithToken<{
				revisiondelete: { items: Array<{ status: string; id: number; action: string; type: string }> };
			}>('csrf', {
				action: 'revisiondelete',
				type: 'logging',
				ids,
				hide: 'content|user|comment',
				suppress: 'yes',
				reason: 'test',
				tags: 'Bot',
			}, { retry: 50, noCache: true });
			data.revisiondelete.items = data.revisiondelete.items
				.map(({ status, id, action, type }) => ({ status, id, action, type }));
			console.log(JSON.stringify(data));
		} catch (error) {
			console.error('revisiondelete(logging) 执行失败:', error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	}));

	await editTimeData(lastTime, 'hide-user-log', lestart);

	console.log(`End time: ${new Date().toISOString()}`);
})();
