import moment from 'moment';
import type { MwAllUser, MwQueryResponse } from '../types/mediawiki.d.ts';
import mapLimit from '../utils/common/concurrency.ts';
import { createAndLogin } from '../utils/core/createApi.ts';
import { safePostWithToken } from '../utils/core/retry.ts';

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	const api = await createAndLogin('zh', 'abot');

	const { data: { query: { allusers } } } = await api.post<MwQueryResponse<{
		allusers: Array<Required<Pick<MwAllUser, 'userid'>> & MwAllUser>;
	}>>({
		list: 'allusers',
		augroup: 'manually-confirmed|extendedconfirmed',
		auprop: 'blockinfo',
		aulimit: 'max',
	}, {
		retry: 15,
	});

	const time = moment().subtract(1, 'week');
	const userids: number[] = allusers
		.filter(({ blockexpiry, blockedtimestamp }) => blockexpiry === 'infinity' && moment(blockedtimestamp).isBefore(time))
		.map(({ userid }) => userid);

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