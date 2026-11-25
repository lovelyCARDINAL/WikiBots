import { load } from 'cheerio';
import { MediaWikiApi } from 'wiki-saikou';
import clientLogin from '../utils/clientLogin.ts';
import config from '../utils/config.ts';
import { getTimeData, editTimeData } from '../utils/lastTime.ts';
import paginate from '../utils/paginate.ts';
import splitAndJoin from '../utils/splitAndJoin.ts';

const zhapi = new MediaWikiApi({
		baseURL: config.zh.api,
		fexiosConfigs: {
			headers: { 'user-agent': config.useragent },
		},
	}),
	cmapi = new MediaWikiApi({
		baseURL: config.cm.api,
		fexiosConfigs: {
			headers: { 'user-agent': config.useragent },
		},
	});

const queryLogs = async (api: MediaWikiApi, leaction: string, leend: string, lestart?: string): Promise<Array<number | string>> => {
	const result: Array<{ logid?: number; title?: string; comment?: string; suppressed?: boolean }> = [];
	for await (const data of paginate(api, {
		list: 'logevents',
		leprop: leaction === 'avatar/delete' ? 'ids|comment' : 'title',
		leaction,
		lestart,
		leend,
		lelimit: 'max',
		...leaction === 'avatar/delete' && { leuser: '星海-adminbot' },
	})) {
		if (data?.query?.logevents) {
			result.push(...data.query.logevents);
		}
	}
	return leaction === 'avatar/delete'
		? [...new Set(result.filter(({ comment, suppressed }) => !suppressed && comment === '被隐藏的用户').map(({ logid }) => logid).filter((id): id is number => typeof id === 'number'))]
		: [...new Set(result.map(({ title }) => title).filter((title): title is string => typeof title === 'string'))];
};

const queryPages = async (apprefix: string, apnamespace: string): Promise<string[]> => {
	const { data: { query: { allpages } } } = await zhapi.post<{
		query: { allpages: Array<{ title: string }> };
	}>({
		list: 'allpages',
		apprefix,
		apnamespace,
	}, {
		retry: 15,
	});
	const user = apprefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const prefixRegex = new RegExp(`^User(?: talk)?:(${user}|${user}/.*)$`);
	return allpages
		.map((page) => page.title)
		.filter((title) => prefixRegex.test(title));
};

const hidePages = async (user: string): Promise<void> => {
	const pagelist = await Promise.all([
		queryPages(user, '2'),
		queryPages(user, '3'),
	]).then((result) => result.flat());

	await Promise.all(pagelist.map(async (title) => {
		let retry = 0;
		while (retry < 30) {
			const { response: { data: htmlString } } = await zhapi.request.get('/index.php', {
				query: {
					title,
					action: 'delete',
				},
			});

			if (htmlString.includes('<title>无法删除页面')) {
				console.warn('The page could not be deleted. It may have already been deleted by someone else.');
				break;
			}

			const $ = load(htmlString);
			const wpEditToken = $('[name="wpEditToken"]').get(0)?.attribs.value;

			if (wpEditToken) {
				const { response: { data } } = await zhapi.request.post('/index.php', {
					title,
					action: 'delete',
					wpDeleteReasonList: 'other',
					wpReason: '被隐藏的用户',
					wpSuppress: '',
					wpConfirmB: '删除页面',
					wpEditToken,
				});
				if (data.includes('<title>操作完成')) {
					console.log('Successful deleted the page');
					break;
				}
			}

			console.warn(`删除页面失败。重试第 ${retry} 次...`);
			retry++;
		}
	}));
};

const hideAbuseLog = async (afluser: string): Promise<void> => {
	let retry = 0;
	while (retry < 30) {
		const ids = await (async () => {
			const result: Array<{ id: number; hidden?: boolean }> = [];
			for await (const data of paginate(zhapi, {
				list: 'abuselog',
				afluser,
				afllimit: 'max',
				aflprop: 'ids|hidden',
			})) {
				if (data?.query?.abuselog) {
					result.push(...data.query.abuselog);
				}
			}
			return result.filter(({ hidden }) => !hidden).map(({ id }) => id);
		})();

		if (!ids.length) {
			break;
		}
		console.log(`Retry: ${retry}, ids: ${ids.length}`);

		await Promise.all(ids.map(async (id) => {
			await zhapi.request.post('/index.php', {
				title: 'Special:滥用日志',
				hide: id,
				wpdropdownreason: 'other',
				wpreason: '被隐藏的用户',
				wphidden: true,
				wpEditToken: await zhapi.token('csrf'),
			}).then(() => console.log(`Try to hide ${id}`));
		}));

		retry++;
	}
};

const deleteAvatar = async (username: string): Promise<void> => {
	try {
		const { data } = await cmapi.post({
			action: 'avatardelete',
			username,
			reason: '被隐藏的用户',
		}, {
			retry: 50,
			noCache: true,
		});
		console.log(JSON.stringify(data));
	} catch (error) {
		const errorCode = (error as { response?: { data?: { errors?: Array<{ code?: string }> } } } | undefined)?.response?.data?.errors?.[0]?.code;
		if (errorCode === 'viewavatar-noavatar') {
			return;
		}
		throw error;
	}
};

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

	await Promise.all(userlist.map(async (user) => {
		await Promise.all([
			hidePages(user),
			hideAbuseLog(user),
			deleteAvatar(user),
		]);
	}));

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

	const idslist = splitAndJoin(idlist, 500);

	await Promise.all(idslist.map(async (ids) => {
		try {
			const { data } = await cmapi.postWithToken<{
				revisiondelete: {
					items: Array<{ status: string; id: number; action: string; type: string }>;
				};
			}>('csrf', {
				action: 'revisiondelete',
				type: 'logging',
				ids,
				hide: 'content|user|comment',
				suppress: 'yes',
				reason: 'test',
				tags: 'Bot',
			}, {
				retry: 50,
				noCache: true,
			});
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
