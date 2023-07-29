import process from 'process';
import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';
import { getTimeData, editTimeData } from './utils/lastTime.js';
import splitAndJoin from './utils/splitAndJoin.js';

const api = new MediaWikiApi(config.cm.api, { headers: { 'api-user-agent': config.apiuseragent } });

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	await api.login(config.cm.abot.name, config.cm.abot.password).then(console.log);

	const lastTime = await getTimeData();
	const leend = lastTime['file-revision-deletion'] ?? (console.error('No last time data!'), process.exit(1)),
		lestart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
	
	const idlist = await (async () => {
		const result = [];
		const eol = Symbol();
		let lecontinue = undefined;
		while (lecontinue !== eol) {
			const { data } = await api.post({
				list: 'logevents',
				leprop: 'ids',
				leaction: 'upload/overwrite',
				lestart,
				leend,
				...lecontinue && { lecontinue },
			}, { retry: 10 });
			lecontinue = data.continue ? data.continue.lecontinue : eol;
			result.push(...data.query.logevents);
		}
		return result.map((item) => item.pageid).filter((id) => id !== 0);
	})();

	const idslist = splitAndJoin([...new Set(idlist)], 500);
	
	const archivelist = await Promise.all(idslist.map(async (ids) => {
		return await (async () => {
			const { data: { query: { pages } } } = await api.post({
				prop: 'imageinfo',
				pageids: ids,
				iiprop: 'archivename',
				iilimit: 'max',
				redirects: true,
			}, { retry: 10 });
			return await Promise.all(pages.map((page) => {
				const ids = page.imageinfo
					.map((item) => !item?.filehidden && item?.archivename)
					.map((name) => /^\d+/.exec(name)?.[0])
					.filter(Boolean);
				if (ids.length > 0) {
					return [page.title, ids];
				}
			}));
		})();
	})).then((result) => result.flat().filter(Boolean));

	await Promise.all(archivelist.map(async ([target, ids]) => {
		const { data } = await api.postWithToken('csrf', {
			action: 'revisiondelete',
			target,
			ids,
			type: 'oldimage',
			hide: 'content',
			reason: '删除长期未使用的旧版本文件',
			tags: 'Bot',
		}, { retry: 10, noCache: true });

		data.revisiondelete.items = data.revisiondelete.items.map(({ status, archivename, timestamp }) => ({ status, archivename, timestamp }));
		
		console.log(JSON.stringify(data));
	}));

	await editTimeData(lastTime, 'file-revision-deletion', lestart);

	console.log(`End time: ${new Date().toISOString()}`);
})();
