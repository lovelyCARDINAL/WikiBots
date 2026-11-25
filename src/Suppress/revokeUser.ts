import { MediaWikiApi } from 'wiki-saikou';
import clientLogin from '../utils/clientLogin.ts';
import config from '../utils/config.ts';
import { safePostWithToken } from '../utils/retry.ts';

const api = new MediaWikiApi({
	baseURL: config.zh.api,
	fexiosConfigs: {
		headers: { 'user-agent': config.useragent },
	},
});

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	await clientLogin(api, config.cm.sbot.account, config.password);

	const avatarLogs = await api.post<{
		query: { logevents: Array<{ logid: number; title: string; suppressed?: boolean }> };
	}>({
		action: 'query',
		format: 'json',
		list: 'logevents',
		formatversion: '2',
		leprop: 'title|details|ids',
		leaction: 'avatar/delete',
		leend: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
		ledir: 'older',
		leuser: '萌娘百科·注销管理员',
		lelimit: 'max',
	}, {
		retry: 15,
	}).then(({ data: { query: { logevents } } }) => logevents.filter(({ suppressed }) => !suppressed));
	console.log(JSON.stringify(avatarLogs));
	const avatarLogIds = avatarLogs.map(({ logid }) => logid);
	const userList = avatarLogs.map(({ title }) => title.replace(/^User:(.+?)\/?$/, '$1'));

	await Promise.all(userList.map(async (user) => {
		await safePostWithToken(api, 'userrights', {
			action: 'userrights',
			user,
			remove: 'goodeditor|honoredmaintainer|techeditor|manually-confirmed|file-maintainer|extendedconfirmed|flood', /*TODO: 可能需要行政员用户组移除Bot用户组 */
			reason: '用户注销',
			tags: 'Bot',
		}, {
			retry: 50,
			noCache: true,
		});
	}));

	const rightLogIds = await api.post<{
		query: { logevents: Array<{ logid: number; comment: string; suppressed?: boolean }> };
	}>({
		list: 'logevents',
		leprop: 'ids|comment',
		leaction: 'rights/rights',
		ledir: 'older',
		leend: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
		leuser: '星海-oversightbot',
		lelimit: 'max',
	}, {
		retry: 15,
	}).then(({ data: { query: { logevents } } }) => logevents.filter(({ suppressed, comment }) => !suppressed && comment === '用户注销').map(({ logid }) => logid));

	await safePostWithToken(api, 'csrf', {
		action: 'revisiondelete',
		type: 'logging',
		ids: [...avatarLogIds, ...rightLogIds].map(String),
		hide: 'content|user|comment',
		suppress: 'yes',
		reason: '用户注销',
		tags: 'Bot',
	}, {
		retry: 50,
		noCache: true,
	});

	console.log(`End time: ${new Date().toISOString()}`);
})();