import type { MediaWikiApi } from 'wiki-saikou';
import type { MwPageContentResponse } from '../types/mediawiki.d.ts';
import { getTimeData, editTimeData } from '../utils/common/lastTime.ts';
import { createAndLogin } from '../utils/core/createApi.ts';
import { safePostWithToken } from '../utils/core/retry.ts';

async function pageEdit(zhapi: MediaWikiApi, title: string, text: string, summary: string, sectiontitle: string): Promise<void> {
	await safePostWithToken(zhapi, 'csrf', {
		action: 'edit',
		title,
		sectiontitle,
		section: 'new',
		text,
		tags: 'Bot',
		summary,
		watchlist: 'nochange',
		bot: true,
	}, {
		retry: 50,
		noCache: true,
	});
}

interface FileInfoPage {
	title: string;
	revisions: Array<{ parentid: number; content: string; user: string }>;
	categories?: Array<{ title: string }>;
}

interface FileCheckContext {
	zhapi: MediaWikiApi;
	badCatSet: Set<string>;
	prefixRegex: RegExp;
	noCatSet: Set<string>;
	noBotsUser: Set<string>;
	badCatUser: Set<string>;
	titleUser: Set<string>;
	linkUser: Set<string>;
	noCatUser: Set<string>;
}

const TITLE_REGEX = /^File:(.+?)\..{3,4}$/;
const NAME_REGEX = /^[a-z0-9.\-@+]+$/i;
const NUMBER_REGEX = /\d\D+\d.*\d|\d.*\d\D+\d/;
const LINK_REGEX = /源地址[:：](.*?)\n/;

function badTitleCheck(title: string): boolean {
	if (title.includes(' ')) {
		return false;
	}
	const match = TITLE_REGEX.exec(title);
	if (!match) {
		return false;
	}
	const name = match[1];
	return name.length > 15 && NAME_REGEX.test(name) && NUMBER_REGEX.test(name);
}

function badLinkCheck(str: string): string | false {
	if (!str.includes('源地址')) {
		return false;
	}
	const match = LINK_REGEX.exec(str);
	const sourceAddress = match?.[1]?.trim();
	return sourceAddress && !sourceAddress.toLowerCase().startsWith('http') ? sourceAddress : false;
}

async function notifyAndLog(
	zhapi: MediaWikiApi,
	user: string,
	hasNoBots: boolean,
	message: string,
	logColumns: string,
): Promise<string> {
	if (!hasNoBots) {
		await pageEdit(zhapi, `User talk:${user}`, message, '关于您近期上传的文件～', '关于您近期上传的文件');
	}
	return `\n|-\n|{{user|${user}}} || ${logColumns} ||${hasNoBots ? ' {{tlx|bots}}' : ''}`;
}

async function processFilePage(page: FileInfoPage, ctx: FileCheckContext): Promise<string> {
	const { title, revisions: [{ content, user }], categories } = page;
	const hasNoBots = ctx.noBotsUser.has(user);
	let log = '';

	if (!ctx.titleUser.has(user) && !ctx.prefixRegex.test(title) && badTitleCheck(title)) {
		ctx.titleUser.add(user);
		log += await notifyAndLog(
			ctx.zhapi,
			user,
			hasNoBots,
			`{{subst:User:星海子/BotMessages/FileName|filename=${title}}}`,
			`[[cm:${title}|${title}]] || 文件名 ||`,
		);
	}

	const foundLink = !ctx.linkUser.has(user) ? badLinkCheck(content) : false;
	if (foundLink) {
		ctx.linkUser.add(user);
		log += await notifyAndLog(
			ctx.zhapi,
			user,
			hasNoBots,
			`{{subst:User:星海子/BotMessages/FileLink|filename=${title}|link=<code><nowiki>${foundLink}</nowiki></code>}}`,
			`[[cm:${title}|${title}]] || 源地址 || <code><nowiki>${foundLink}</nowiki></code>`,
		);
	}

	const categoryData = categories?.map((item) => item.title) || [];
	if (!ctx.noCatUser.has(user) && !categoryData.some((cat) => !ctx.noCatSet.has(cat))) {
		ctx.noCatUser.add(user);
		log += await notifyAndLog(
			ctx.zhapi,
			user,
			hasNoBots,
			`{{subst:User:星海子/BotMessages/FileNoCat|filename=${title}}}`,
			`[[cm:${title}|${title}]] || 分类 || 无实质分类`,
		);
	}

	if (!ctx.badCatUser.has(user)) {
		const badCategories = categoryData.filter((cat) => ctx.badCatSet.has(cat));
		if (badCategories.length > 0) {
			const badCategoryLinks = badCategories.map((cat) => `[[[[:cm:${cat}|${cat}]]]]`).join('、');
			ctx.badCatUser.add(user);
			log += await notifyAndLog(
				ctx.zhapi,
				user,
				hasNoBots,
				`{{subst:User:星海子/BotMessages/FileCat|filename=${title}|category=${badCategoryLinks}}}`,
				`[[cm:${title}|${title}]] || 分类 || ${badCategoryLinks}`,
			);
		}
	}

	return log;
}

async function loadFileInfoConfig(zhapi: MediaWikiApi) {
	const { data: { query: { pages: [{ revisions: [{ content }] }] } } } = await zhapi.post<MwPageContentResponse>({
		prop: 'revisions',
		titles: 'User:星海子/BotConfig/incorrectFileInfo.json',
		rvprop: 'content',
	}, {
		retry: 15,
	});
	const jsonContent = JSON.parse(content) as {
		badCategory: string[];
		badCategoryOverride: string[];
		titlePrefixOverride: string[];
		noCategory: string[];
	};
	return {
		badCatSet: new Set(
			jsonContent.badCategory
				.flatMap((name) => ['Category:', 'Category:作者:'].map((prefix) => `${prefix}${name}`))
				.filter((item) => !jsonContent.badCategoryOverride.includes(item.replace('Category:', ''))),
		),
		prefixRegex: jsonContent.titlePrefixOverride.length
			? new RegExp(`File:(?:${jsonContent.titlePrefixOverride.join('|')})`)
			: /$^/,
		noCatSet: new Set(jsonContent.noCategory.map((name) => `Category:${name}`)),
	};
}

async function fetchNoBotsUsers(zhapi: MediaWikiApi): Promise<Set<string>> {
	const { data } = await zhapi.post<{
		query?: { pages?: Array<{ title: string; revisions?: Array<{ content?: string }> }> };
	}>({
		prop: 'revisions',
		titles: 'Template:Bots',
		generator: 'transcludedin',
		rvprop: 'content',
		gtiprop: 'title',
		gtinamespace: '3',
		gtilimit: 'max',
	}, {
		retry: 15,
	});
	const regex = /{{(?:[Nn]obots|[Bb]ots\|(?:allow=none|deny=.*?机娘星海酱|optout=(?:all|.*?fileInfo)|deny=all))}}/;
	return new Set(
		(data?.query?.pages ?? [])
			.filter((page) => regex.test((page.revisions?.[0]?.content ?? '').replace(/\s\n/g, '')))
			.map((page) => page.title.slice('User talk:'.length)),
	);
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	const [zhapi, cmapi] = await Promise.all([
		createAndLogin('zh', 'bot'),
		createAndLogin('cm', 'bot'),
	]);

	const [{ badCatSet, prefixRegex, noCatSet }, noBotsUser, lastTime] = await Promise.all([
		loadFileInfoConfig(zhapi),
		fetchNoBotsUsers(zhapi),
		getTimeData('file-info'),
	]);

	const gaistart = lastTime['file-info'],
		gaiend = new Date(Date.now() - 5 * 60 * 1000).toISOString();

	const fileData = await cmapi.post({
		prop: 'revisions|categories',
		generator: 'allimages',
		rvprop: 'user|content|timestamp|ids',
		cllimit: 'max',
		gaisort: 'timestamp',
		gaidir: 'newer',
		gaistart,
		gaiend,
		gaifilterbots: 'nobots',
		gailimit: '500',
	}, {
		retry: 15,
	}).then(({ data }) => (data?.query?.pages as FileInfoPage[] | undefined)?.filter((page) => page.revisions?.[0]?.parentid === 0));

	if (fileData) {
		const ctx: FileCheckContext = {
			zhapi,
			badCatSet,
			prefixRegex,
			noCatSet,
			noBotsUser,
			badCatUser: new Set<string>(),
			titleUser: new Set<string>(),
			linkUser: new Set<string>(),
			noCatUser: new Set<string>(),
		};
		const appendtext = (await Promise.all(fileData.map((page) => processFilePage(page, ctx)))).join('');
		if (appendtext) {
			await safePostWithToken(zhapi, 'csrf', {
				action: 'edit',
				pageid: '541069',
				summary: 'log: file-info',
				appendtext,
				tags: 'Bot',
				bot: true,
				minor: true,
				watchlist: 'nochange',
			}, {
				retry: 50,
				noCache: true,
			});
		}
	}

	await editTimeData(lastTime, 'file-info', gaiend);

	console.log(`End time: ${new Date().toISOString()}`);
})();