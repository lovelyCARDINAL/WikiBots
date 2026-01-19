import { load } from 'cheerio';
import { MediaWikiApi } from 'wiki-saikou';
import clientLogin from '../utils/clientLogin.js';
import config from '../utils/config.js';
import { getTimeData, editTimeData } from '../utils/lastTime.js';
import splitAndJoin from '../utils/splitAndJoin.js';

const zhapi = new MediaWikiApi(config.zh.api, {
		headers: { 'user-agent': config.useragent },
	}),
	cmapi = new MediaWikiApi(config.cm.api, {
		headers: { 'user-agent': config.useragent },
	});

const queryLogs = async (api, leaction, leend, lestart = undefined) => {
	const result = [];
	const eol = Symbol();
	let lecontinue = undefined;
	while (lecontinue !== eol) {
		const { data } = await api.post({
			list: 'logevents',
			leprop: leaction === 'avatar/delete' ? 'ids|comment' : 'title',
			leaction,
			lestart,
			leend,
			lelimit: 'max',
			...leaction === 'avatar/delete' && { leuser: '星海-adminbot' },
			lecontinue,
		}, {
			retry: 15,
		});
		lecontinue = data.continue ? data.continue.lecontinue : eol;
		result.push(...data.query.logevents);
	}
	return leaction === 'avatar/delete'
		? [...new Set(result.filter(({ comment, suppressed }) => !suppressed && comment === '被隐藏的用户').map(({ logid }) => logid))]
		: [...new Set(result.map(({ title }) => title))];
};

const queryPages = async (apprefix, apnamespace) => {
	const { data: { query: { allpages } } } = await zhapi.post({
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

const hidePages = async (user) => {
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

const hideAbuseLog = async (afluser) => {
	let retry = 0;
	while (retry < 30) {
		const ids = await (async () => {
			const result = [];
			const eol = Symbol();
			let aflstart = undefined;
			while (aflstart !== eol) {
				const { data } = await zhapi.post({
					list: 'abuselog',
					afluser,
					afllimit: 'max',
					aflprop: 'ids|hidden',
					aflstart,
				}, {
					retry: 15,
				});
				aflstart = data.continue ? data.continue.aflstart : eol;
				result.push(...data.query.abuselog);
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

const deleteAvatar = async (username) => {
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
		const errorCode = error?.response?.data?.errors?.[0]?.code;
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
	]).then((result) => result.flat().map((title) => title.replace('User:', '')));

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
			const eol = Symbol();
			let lecontinue = undefined;
			while (lecontinue !== eol) {
				const { data } = await cmapi.post({
					list: 'logevents',
					leprop: 'ids',
					leuser: user.replace('User:', ''),
					lelimit: 'max',
					lecontinue,
				}, {
					retry: 15,
				});
				lecontinue = data.continue ? data.continue.lecontinue : eol;
				result.push(...data.query.logevents);
			}
			return result
				.filter(({ suppressed }) => !suppressed)
				.map(({ logid }) => logid);
		})),
		queryLogs(cmapi, 'avatar/delete', new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()),
	]).then((result) => result.flat(Infinity));

	const idslist = splitAndJoin(idlist, 500);

	await Promise.all(idslist.map(async (ids) => {
		await cmapi.postWithToken('csrf', {
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
		}).then(({ data }) => {
			data.revisiondelete.items = data.revisiondelete.items
				.map(({ status, id, action, type }) => ({ status, id, action, type }));
			console.log(JSON.stringify(data));
		});
	}));

	await editTimeData(lastTime, 'hide-user-log', lestart);

	console.log(`End time: ${new Date().toISOString()}`);
})();
