import moment from 'moment';
import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';

const api = new MediaWikiApi(config.zh.api, {
	headers: { 'api-user-agent': config.apiuseragent },
});

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	await api.login(config.zh.abot.name, config.zh.abot.password).then(console.log);

	const { data: { query: { allusers } } } = await api.post({
		list: 'allusers',
		augroup: 'manually-confirmed|extendedconfirmed',
		auprop: 'blockinfo',
		aulimit: 'max',
	});

	const time = moment().subtract(1, 'week');
	const userids = allusers
		.filter(({ blockexpiry, blockedtimestamp }) => blockexpiry === 'infinity' && moment(blockedtimestamp).isBefore(time))
		.map(({ userid }) => userid);

	await Promise.all(userids.map(async (userid) => {
		await api.postWithToken('userrights', {
			action: 'userrights',
			userid,
			remove: 'goodeditor|honoredmaintainer|techeditor|manually-confirmed|file-maintainer|extendedconfirmed',
			reason: '无限期封禁',
			tags: 'Bot',
		}, {
			retry: 50,
			noCache: true,
		}).then(({ data }) => console.log(JSON.stringify(data)));
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();