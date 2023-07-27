import { env } from 'process';
import { Octokit } from '@octokit/core';
import { load } from 'js-yaml';
import moment from 'moment';
import { MediaWikiApi } from 'wiki-saikou';
import clientLogin from './utils/clientLogin.js';
import config from './utils/config.js';
import jsonToFormData from './utils/jsonToFormData.js';

const zhabot = new MediaWikiApi(config.zh.api, { headers: { 'api-user-agent': config.apiuseragent } }),
	cmabot = new MediaWikiApi(config.cm.api, { headers: { 'api-user-agent': config.apiuseragent } }),
	zhsbot = new MediaWikiApi(config.zh.api, { headers: { 'api-user-agent': config.apiuseragent } }),
	cmsbot = new MediaWikiApi(config.cm.api, { headers: { 'api-user-agent': config.apiuseragent } });

const octokit = new Octokit({ auth: env.GHP });

async function getRevokeList() {
	const pages = await (async () => {
		const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
			owner: 'lovelyCARDINAL',
			repo: 'moegirl-revoke-user',
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
			owner: 'lovelyCARDINAL',
			repo: 'moegirl-revoke-user',
			path: `data/${newPage}`,
			mediaType: {
				format: 'raw',
			},
		});
		return load(data);
	})();
}

async function manageTags(operation) {
	const { data } = await zhabot.postWithToken('csrf', {
		action: 'managetags',
		operation,
		tag: 'RevokeUser',
		reason: '用户注销',
		ignorewarnings: true,
		tags: 'Bot',
	}, { retry: 10, noCache: true });
	console.log(JSON.stringify(data));
}

async function deleteAvatar(user) {
	await cmabot.request.post('/index.php', jsonToFormData({
		title: 'Special:查看头像',
		'delete': 'true',
		user,
		reason: '用户注销',
	}), { retry: 10 }).then(() => {
		console.log(`Deleted avatar of User:${user}.`);
	});
}

async function deleteRights(user) {
	const { data } = await cmabot.postWithToken('userrights', {
		action: 'userrights',
		user,
		remove: 'goodeditor|honoredmaintainer|techeditor|manually-confirmed|file-maintainer|extendedconfirmed',
		reason: '用户注销',
		tags: 'Bot',
		formatversion: '2',
	}, { retry: 10, noCache: true });
	console.log(JSON.stringify(data));
}

async function deletePages(user) {
	const { data: { query: { allpages } } } = await zhabot.post({
		list: 'allpages',
		apprefix: user,
		apnamespace: '2',
	}, { retry: 10 });
	const pagelist = allpages
		.map((page) => page.title)
		.filter((title) => title.startsWith(`User:${user}/`) || title === `User:${user}`);
	await Promise.all(pagelist.map(async (title) => {
		const { data } = await zhsbot.postWithToken('csrf', {
			action: 'delete',
			title,
			reason: '用户注销',
			tags: 'Bot|RevokeUser',
		}, { retry: 10, noCache: true });
		/cantedit|protected/.test(data?.errors?.[0]?.code) ? console.warn(`[[${title}]] is protected.`) : console.log(JSON.stringify(data));
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
	}, { retry: 10 });
	return logevents
		.filter((log) => !log?.suppressed && log.comment === '用户注销')
		.map((log) => log.logid);
}

async function hideLogs(api, ids) {
	const { data } = await api.postWithToken('csrf', {
		action: 'revisiondelete',
		type: 'logging',
		ids,
		hide: 'content|user|comment',
		suppress: 'yes',
		reason: '用户注销',
		tags: 'Bot',
	}, { retry: 10, noCache: true });
	console.log(JSON.stringify(data));
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	const userlist = await getRevokeList();

	await Promise.all([
		clientLogin(zhabot, config.zh.abot.account, config.password),
		clientLogin(cmabot, config.cm.abot.account, config.password),
		clientLogin(zhsbot, config.cm.sbot.account, config.password),
		clientLogin(cmsbot, config.cm.sbot.account, config.password),
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
			queryLogs(cmsbot, 'avatar/delete', config.zh.abot.account),
			queryLogs(cmsbot, 'rights/rights', config.zh.abot.account),
		]).then((ids) => ids.flat()),
		queryLogs(zhabot, 'delete/delete', config.zh.sbot.account),
	]);

	await Promise.all([
		cmidlist.length && hideLogs(cmsbot, cmidlist),
		zhidlist.length && hideLogs(zhsbot, zhidlist),
	]);

	await manageTags('deactivate');

	console.log(`End time: ${new Date().toISOString()}`);
})();