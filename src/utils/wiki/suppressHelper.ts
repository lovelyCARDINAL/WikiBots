import { load } from 'cheerio';
import type { MediaWikiApi } from 'wiki-saikou';
import paginate from '../core/paginate.ts';

export const queryLogs = async (api: MediaWikiApi, leaction: string, leend: string, lestart?: string): Promise<Array<number | string>> => {
	const result: Array<{ logid?: number; title?: string; comment?: string; suppressed?: boolean }> = [];
	for await (const data of paginate(api, {
		list: 'logevents',
		leprop: leaction === 'avatar/delete' ? 'ids|comment' : 'title',
		leaction,
		lestart,
		leend,
		lelimit: 'max',
		...leaction === 'avatar/delete' && { leuser: '星海-adminbot' },
	})) {
		if (data?.query?.logevents) {
			result.push(...data.query.logevents);
		}
	}
	return leaction === 'avatar/delete'
		? [...new Set(result.filter(({ comment, suppressed }) => !suppressed && comment === '被隐藏的用户').map(({ logid }) => logid).filter((id): id is number => typeof id === 'number'))]
		: [...new Set(result.map(({ title }) => title).filter((title): title is string => typeof title === 'string'))];
};

const queryPages = async (zhapi: MediaWikiApi, apprefix: string, apnamespace: string): Promise<string[]> => {
	const { data: { query: { allpages } } } = await zhapi.post<{
		query: { allpages: Array<{ title: string }> };
	}>({ list: 'allpages', apprefix, apnamespace }, { retry: 15 });
	const user = apprefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const prefixRegex = new RegExp(`^User(?: talk)?:(${user}|${user}/.*)$`);
	return allpages.map((page) => page.title).filter((title) => prefixRegex.test(title));
};

const tryDeleteUserPage = async (zhapi: MediaWikiApi, title: string): Promise<boolean> => {
	const { response: { data: htmlString } } = await zhapi.request.get('/index.php', {
		query: { title, action: 'delete' },
	});
	if (htmlString.includes('<title>无法删除页面')) {
		console.warn('The page could not be deleted. It may have already been deleted by someone else.');
		return true;
	}
	const $ = load(htmlString);
	const wpEditToken = $('[name="wpEditToken"]').get(0)?.attribs.value;
	if (!wpEditToken) {
		return false;
	}
	const { response: { data } } = await zhapi.request.post('/index.php', {
		title,
		action: 'delete',
		wpDeleteReasonList: 'other',
		wpReason: '被隐藏的用户',
		wpSuppress: '',
		wpConfirmB: '删除页面',
		wpEditToken,
	});
	if (!data.includes('<title>操作完成')) {
		return false;
	}
	console.log('Successful deleted the page');
	return true;
};

export const hidePages = async (zhapi: MediaWikiApi, user: string): Promise<void> => {
	const pagelist = await Promise.all([
		queryPages(zhapi, user, '2'),
		queryPages(zhapi, user, '3'),
	]).then((result) => result.flat());

	await Promise.all(pagelist.map(async (title) => {
		for (let retry = 0; retry < 30; retry++) {
			if (await tryDeleteUserPage(zhapi, title)) {
				return;
			}
			console.warn(`删除页面失败。重试第 ${retry} 次...`);
		}
	}));
};

export const hideAbuseLog = async (zhapi: MediaWikiApi, afluser: string): Promise<void> => {
	let retry = 0;
	while (retry < 30) {
		const result: Array<{ id: number; hidden?: boolean }> = [];
		for await (const data of paginate(zhapi, {
			list: 'abuselog',
			afluser,
			afllimit: 'max',
			aflprop: 'ids|hidden',
		})) {
			if (data?.query?.abuselog) {
				result.push(...data.query.abuselog);
			}
		}
		const ids = result.filter(({ hidden }) => !hidden).map(({ id }) => id);
		if (!ids.length) {
			break;
		}
		console.log(`Retry: ${retry}, ids: ${ids.length}`);

		await Promise.all(ids.map(async (id) => {
			await zhapi.request.post('/index.php', {
				title: 'Special:滥用日志',
				hide: id,
				wpdropdownreason: 'other',
				wpreason: '被隐藏的用户',
				wphidden: true,
				wpEditToken: await zhapi.token('csrf'),
			}).then(() => console.log(`Try to hide ${id}`));
		}));

		retry++;
	}
};

export const deleteAvatar = async (cmapi: MediaWikiApi, username: string): Promise<void> => {
	try {
		const { data } = await cmapi.post({
			action: 'avatardelete',
			username,
			reason: '被隐藏的用户',
		}, { retry: 50, noCache: true });
		console.log(JSON.stringify(data));
	} catch (error) {
		const errorCode = (error as { response?: { data?: { errors?: Array<{ code?: string }> } } } | undefined)?.response?.data?.errors?.[0]?.code;
		if (errorCode === 'viewavatar-noavatar') {
			return;
		}
		throw error;
	}
};
