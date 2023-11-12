import { env } from 'process';
import { Octokit } from '@octokit/core';
import { load } from 'js-yaml';
import moment from 'moment';
import { MediaWikiApi } from 'wiki-saikou';
import clientLogin from '../utils/clientLogin.js';
import config from '../utils/config.js';

const zhapi = new MediaWikiApi(config.zh.api, {
		headers: { 'api-user-agent': config.apiuseragent },
	}),
	cmapi = new MediaWikiApi(config.cm.api, {
		headers: { 'api-user-agent': config.apiuseragent },
	});

const octokit = new Octokit({ auth: env.GHP });

async function getRevokeList() {
	const pages = await (async () => {
		const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
			owner: 'moepad',
			repo: 'revoke-user',
			path: 'data',
		});
		return data
			.filter((item) => item.type === 'file')
			.map((item) => item.name);
	})();
	const dates = pages.map((date) => moment(date.replace('.yaml', ''), 'YYYY-MM-DD'));
	const maxDate = moment.max(dates);
	const newPage = pages[dates.indexOf(maxDate)];
	return await (async () => {
		const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
			owner: 'moepad',
			repo: 'revoke-user',
			path: `data/${newPage}`,
			mediaType: {
				format: 'raw',
			},
		});
		return load(data);
	})();
}

async function manageTags(operation) {
	const { data } = await zhapi.postWithToken('csrf', {
		action: 'managetags',
		operation,
		tag: 'RevokeUser',
		reason: '用户注销',
		ignorewarnings: true,
		tags: 'Bot',
	}, {
		retry: 50,
		noCache: true,
	});
	console.log(JSON.stringify(data));
}

async function deleteAvatar(user) {
	let retry = 0;
	while (retry < 15) {
		const { response: { data } } = await cmapi.request.post('/index.php', {
			title: 'Special:查看头像',
			'delete': 'true',
			user,
			reason: '用户注销',
		});
		if (data.includes('该用户没有头像。')) {
			console.log(`Successful deleted the avatar of ${user}`);
			break;
		}
		retry++;
		if (retry === 10) {
			console.warn(`Failed to delete the avatar of ${user}`);
		}
	}
}

async function deleteRights(user) {
	await cmapi.postWithToken('userrights', {
		action: 'userrights',
		user,
		remove: 'goodeditor|honoredmaintainer|techeditor|manually-confirmed|file-maintainer|extendedconfirmed',
		reason: '用户注销',
		tags: 'Bot',
	}, {
		retry: 50,
		noCache: true,
	}).then(({ data }) => console.log(JSON.stringify(data)));
}

async function deletePages(user) {
	const { data: { query: { allpages } } } = await zhapi.post({
		list: 'allpages',
		apprefix: user,
		apnamespace: '2',
	}, {
		retry: 15,
	});
	const pagelist = allpages
		.map((page) => page.title)
		.filter((title) => title.startsWith(`User:${user}/`) || title === `User:${user}`);
	await Promise.all(pagelist.map(async (title) => {
		await zhapi.postWithToken('csrf', {
			action: 'delete',
			title,
			reason: '用户注销',
			tags: 'Bot|RevokeUser',
		}, {
			retry: 50,
			noCache: true,
		}).then(({ data }) => /cantedit|protected/.test(data?.errors?.[0]?.code) ? console.warn(`[[${title}]] is protected.`) : console.log(JSON.stringify(data)));
	}));
}

async function queryLogs(api, leaction, leuser) {
	const { data: { query: { logevents } } } = await api.post({
		list: 'logevents',
		leprop: 'ids|comment',
		leaction,
		leend: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
		leuser,
		lelimit: 'max',
	}, {
		retry: 15,
	});
	return logevents
		.filter(({ suppressed, comment }) => !suppressed && comment === '用户注销')
		.map(({ logid }) => logid);
}

async function hideLogs(api, ids) {
	await api.postWithToken('csrf', {
		action: 'revisiondelete',
		type: 'logging',
		ids,
		hide: 'content|user|comment',
		suppress: 'yes',
		reason: '用户注销',
		tags: 'Bot',
	}, {
		retry: 50,
		noCache: true,
	}).then(({ data }) => console.log(JSON.stringify(data)));
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	const userlist = await getRevokeList();

	await Promise.all([
		clientLogin(zhapi, config.cm.sbot.account, config.password),
		clientLogin(cmapi, config.cm.sbot.account, config.password),
	]);

	await manageTags('activate');

	await Promise.all(userlist.map(async (user) => {
		await Promise.all([
			deleteAvatar(user),
			deleteRights(user),
			deletePages(user),
		]);
	}));

	const [cmidlist, zhidlist] = await Promise.all([
		Promise.all([
			queryLogs(cmapi, 'avatar/delete', config.zh.sbot.account),
			queryLogs(cmapi, 'rights/rights', config.zh.sbot.account),
		]).then((ids) => ids.flat()),
		queryLogs(zhapi, 'delete/delete', config.zh.sbot.account),
	]);

	await Promise.all([
		cmidlist.length && hideLogs(cmapi, cmidlist),
		zhidlist.length && hideLogs(zhapi, zhidlist),
	]);

	await manageTags('deactivate');

	console.log(`End time: ${new Date().toISOString()}`);
})();