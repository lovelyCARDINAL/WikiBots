import moment from 'moment';
import mapLimit from '../utils/concurrency.js';
import { createAndLogin } from '../utils/createApi.js';
import { safePostWithToken } from '../utils/retry.js';

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	const api = await createAndLogin('zh', 'abot');

	const { data: { query: { allusers } } } = await api.post({
		list: 'allusers',
		augroup: 'manually-confirmed|extendedconfirmed',
		auprop: 'blockinfo',
		aulimit: 'max',
	}, {
		retry: 15,
	});

	const time = moment().subtract(1, 'week');
	const userids = allusers
		.filter(({ blockexpiry, blockedtimestamp }) => blockexpiry === 'infinity' && moment(blockedtimestamp).isBefore(time))
		.map(({ userid }) => ![86212].includes(userid) && userid)
		.filter(Boolean);

	await mapLimit(userids, 5, async (userid) => {
		await safePostWithToken(api, 'userrights', {
			action: 'userrights',
			userid,
			remove: 'goodeditor|honoredmaintainer|techeditor|manually-confirmed|file-maintainer|extendedconfirmed',
			reason: '无限期封禁',
			tags: 'Bot',
		}, {
			retry: 50,
			noCache: true,
		});
	});

	console.log(`End time: ${new Date().toISOString()}`);
})();