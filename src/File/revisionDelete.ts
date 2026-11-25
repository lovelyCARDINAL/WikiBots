import mapLimit from '../utils/common/concurrency.ts';
import { getTimeData, editTimeData } from '../utils/common/lastTime.ts';
import splitAndJoin from '../utils/common/splitAndJoin.ts';
import { createAndLogin } from '../utils/core/createApi.ts';
import paginate from '../utils/core/paginate.ts';

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	const api = await createAndLogin('cm', 'abot');

	const lastTime = await getTimeData('file-revision-deletion');
	const leend = lastTime['file-revision-deletion'],
		lestart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

	const idlist = await (async () => {
		const result: Array<{ pageid?: number }> = [];
		for await (const data of paginate(api, {
			list: 'logevents',
			leprop: 'ids',
			leaction: 'upload/overwrite',
			lestart,
			leend,
		})) {
			if (data?.query?.logevents) {
				result.push(...data.query.logevents);
			}
		}
		return result.map((item) => item.pageid).filter((id): id is number => typeof id === 'number' && id !== 0);
	})();

	const idslist = splitAndJoin([...new Set(idlist)], 500);

	interface ArchivePage {
		title: string;
		imageinfo?: Array<{ filehidden?: boolean; archivename?: string }>;
	}
	const archivelist = await mapLimit(idslist, 3, async (ids): Promise<Array<[string, string[]]>> => {
		const { data } = await api.post<{
			query?: { pages?: ArchivePage[] };
		}>({
			prop: 'imageinfo',
			pageids: ids,
			iiprop: 'archivename',
			iilimit: 'max',
			redirects: true,
		}, {
			retry: 15,
		});
		const pages = data?.query?.pages || [];
		return pages.map((page): [string, string[]] | null => {
			const archiveIds = (page.imageinfo || [])
				.filter((item) => !item?.filehidden && item?.archivename)
				.map((item) => /^\d+/.exec(item.archivename!)?.[0])
				.filter((id): id is string => Boolean(id));
			return archiveIds.length > 0 ? [page.title, archiveIds] : null;
		}).filter((entry): entry is [string, string[]] => Boolean(entry));
	}).then((result) => result.flat());

	await mapLimit(archivelist, 5, async ([target, ids]) => {
		try {
			const { data } = await api.postWithToken<{
				revisiondelete?: {
					items?: Array<{ status: string; archivename: string; timestamp: string }>;
				};
			}>('csrf', {
				action: 'revisiondelete',
				target,
				ids,
				type: 'oldimage',
				hide: 'content',
				reason: '删除长期未使用的旧版本文件',
				tags: 'Bot',
			}, {
				retry: 50,
				noCache: true,
			});
			if (data?.revisiondelete?.items) {
				data.revisiondelete.items = data.revisiondelete.items
					.map(({ status, archivename, timestamp }) => ({ status, archivename, timestamp }));
			}
			console.log(JSON.stringify(data));
		} catch (error) {
			console.error(`revisiondelete(${target}) 执行失败:`, error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	});

	await editTimeData(lastTime, 'file-revision-deletion', lestart);

	console.log(`End time: ${new Date().toISOString()}`);
})();
