import process from 'process';
import { MediaWikiApi } from 'wiki-saikou';
import { getTimeData, editTimeData } from '../utils/common/lastTime.ts';
import clientLogin from '../utils/core/clientLogin.ts';
import config from '../utils/core/config.ts';
import paginate from '../utils/core/paginate.ts';
import { hideAbuseLogIds } from '../utils/wiki/suppressHelper.ts';

const api = new MediaWikiApi({
	baseURL: config.zh.api,
	fexiosConfigs: {
		headers: { 'user-agent': config.useragent },
	},
});

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	await clientLogin(api, config.zh.sbot.account, config.password);

	const lastTime = await getTimeData('hide-page-log');
	const leend = lastTime['hide-page-log'],
		lestart = new Date().toISOString();

	let retry = 0;
	let remainingIds = 0;
	while (retry < 30) {
		console.groupCollapsed(`Retry: ${retry}`);
		const titles = await (async () => {
			const result = [];
			for await (const data of paginate(api, {
				list: 'logevents',
				leprop: 'title|comment',
				leaction: 'suppress/delete',
				lestart,
				leend,
				lelimit: 'max',
			})) {
				if (data?.query?.logevents) {
					result.push(...data.query.logevents);
				}
			}
			return [...new Set(result.map(({ title, comment }) => comment !== '被隐藏的用户' && title).filter(Boolean))];
		})();
		console.log(`titles: ${titles.length}`);

		const ids = await Promise.all(titles.map(async (title) => {
			const result: Array<{ id: number; hidden?: boolean }> = [];
			for await (const data of paginate(api, {
				list: 'abuselog',
				afltitle: title,
				afllimit: 'max',
				aflprop: 'ids|hidden',
			})) {
				if (data?.query?.abuselog) {
					result.push(...data.query.abuselog);
				}
			}
			return result.filter(({ hidden }) => !hidden).map(({ id }) => id);
		})).then((result) => result.flat());

		console.log(`ids: ${ids.length}`);
		remainingIds = ids.length;
		if (!ids.length) {
			console.groupEnd();
			break;
		}

		await hideAbuseLogIds(api, ids, '被隐藏的页面');
		console.groupEnd();

		retry++;
	}

	if (remainingIds > 0) {
		console.error(`Failed to hide ${remainingIds} abuse log(s) after ${retry} retries.`);
		process.exitCode = 1;
	} else {
		await editTimeData(lastTime, 'hide-page-log', lestart);
	}

	console.log(`End time: ${new Date().toISOString()}`);
})();
