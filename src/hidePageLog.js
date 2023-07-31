import { MediaWikiApi } from 'wiki-saikou';
import clientLogin from './utils/clientLogin.js';
import config from './utils/config.js';
import { getTimeData, editTimeData } from './utils/lastTime.js';

const api = new MediaWikiApi(config.zh.api, { headers: { 'api-user-agent': config.apiuseragent } });

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	await clientLogin(api, config.zh.sbot.account, config.password);

	const lastTime = await getTimeData('hide-page-log');
	const leend = lastTime['hide-page-log'],
		lestart = new Date().toISOString();

	let retry = 0;
	while (retry < 20) {
		const titles = await (async () => {
			const result = [];
			const eol = Symbol();
			let lecontinue = undefined;
			while (lecontinue !== eol) {
				const { data } = await api.post({
					list: 'logevents',
					leprop: 'title|comment',
					leaction: 'suppress/delete',
					lestart,
					leend,
					lelimit: 'max',
					...lecontinue && { lecontinue },
				}, { retry: 10 });
				lecontinue = data.continue ? data.continue.lecontinue : eol;
				result.push(...data.query.logevents);
			}
			return [...new Set(result.map(({ title, comment }) => comment !== '被隐藏的用户' && title))];
		})();

		const ids = await Promise.all(titles.map(async (title) => {
			const result = [];
			const eol = Symbol();
			let aflstart = undefined;
			while (aflstart !== eol) {
				const { data } = await api.post({
					list: 'abuselog',
					afltitle: title,
					afllimit: 'max',
					aflprop: 'ids|hidden',
					...aflstart && { aflstart },
				}, { retry: 10 });
				aflstart = data.continue ? data.continue.aflstart : eol;
				result.push(...data.query.abuselog);
			}
			return result.filter(({ hidden }) => !hidden).map(({ id }) => id);
		})).then((result) => result.flat());

		if (!ids.length) {
			break;
		}
		console.log(`Retry: ${retry}, ids: ${ids.length}`);

		await Promise.all(ids.map(async (id) => {
			await api.request.post('/index.php', {
				title: 'Special:滥用日志',
				hide: id,
				wpdropdownreason: 'other',
				wpreason: '被隐藏的页面',
				wphidden: true,
				wpEditToken: await api.token('csrf'),
			}).then(() => console.log(`Try to hide ${id}`));
		}));

		retry++;
	}

	await editTimeData(lastTime, 'hide-page-log', lestart);

	console.log(`End time: ${new Date().toISOString()}`);
})();
