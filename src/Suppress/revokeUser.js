import { env } from 'process';
import { Octokit } from '@octokit/core';
import { load } from 'js-yaml';
import moment from 'moment';
import { MediaWikiApi } from 'wiki-saikou';
import clientLogin from '../utils/clientLogin.js';
import config from '../utils/config.js';

const zhapi = new MediaWikiApi(config.zh.api, {
		headers: { 'user-agent': config.useragent },
	}),
	cmapi = new MediaWikiApi(config.cm.api, {
		headers: { 'user-agent': config.useragent },
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

const deleteAvatar = async (username) => {
	try {
		const { data } = await cmapi.post({
			action: 'avatardelete',
			username,
			reason: '用户注销',
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

const deleteRights = async (user) => {
	const { data } = await cmapi.postWithToken('userrights', {
		action: 'userrights',
		user,
		remove: 'goodeditor|honoredmaintainer|techeditor|manually-confirmed|file-maintainer|extendedconfirmed',
		reason: '用户注销',
		tags: 'Bot',
	}, {
		retry: 50,
		noCache: true,
	});
	console.log(JSON.stringify(data));
};

const deletePages = async (username) => {
	const user = username.replaceAll('_', ' ');
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
		try {
			const { data } = await zhapi.postWithToken('csrf', {
				action: 'delete',
				title,
				reason: '用户注销',
				tags: 'Bot|RevokeUser',
			}, {
				retry: 50,
				noCache: true,
			});
			console.log(JSON.stringify(data));
		} catch (error) {
			const errorCode = error?.response?.data?.errors?.[0]?.code;
			if (errorCode && /cantedit|protected/.test(errorCode)) {
				console.warn(`[[${title}]] is protected.`);
			} else {
				console.error(`Failed to delete [[${title}]]:`, error);
			}
		}
	}),
	);
};

const queryLogs = async (api, leaction, leuser) => {
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
};

const hideLogs = async (api, ids) => {
	const { data } = await api.postWithToken('csrf', {
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
	});
	console.log(JSON.stringify(data));
};

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