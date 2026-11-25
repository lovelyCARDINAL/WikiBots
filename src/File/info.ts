import type { MediaWikiApi } from 'wiki-saikou';
import type { MwPageContentResponse } from '../types/mediawiki.d.ts';
import { createAndLogin } from '../utils/createApi.ts';
import { getTimeData, editTimeData } from '../utils/lastTime.ts';
import { safePostWithToken } from '../utils/retry.ts';

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

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	const [zhapi, cmapi] = await Promise.all([
		createAndLogin('zh', 'bot'),
		createAndLogin('cm', 'bot'),
	]);

	// 获取分类配置
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

	// 错误分类配置
	const badCatSet = new Set(
		jsonContent.badCategory
			.flatMap((name) => ['Category:', 'Category:作者:'].map((prefix) => `${prefix}${name}`))
			.filter((item) => !jsonContent.badCategoryOverride.includes(item.replace('Category:', ''))),
	);

	// 文件名前缀忽略配置
	const prefixRegex = new RegExp(`File:(?:${jsonContent.titlePrefixOverride.join('|')})`);

	// 无分类忽略配置
	const noCatSet = new Set(jsonContent.noCategory.map((name) => `Category:${name}`));

	// 获取不接受bot操作的用户列表
	const noBotsUser = await (async () => {
		const { data: { query: { pages } } } = await zhapi.post<{
			query: { pages: Array<{ title: string; revisions: Array<{ content: string }> }> };
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
			pages
				.filter((page) => regex.test(page.revisions[0].content.replace(/\s\n/g, '')))
				.map((page) => page.title.slice('User talk:'.length)),
		);
	})();

	// 获取上次运行时间
	const lastTime = await getTimeData('file-info');
	const gaistart = lastTime['file-info'],
		gaiend = new Date(Date.now() - 5 * 60 * 1000).toISOString();

	interface FileInfoPage {
		title: string;
		revisions: Array<{ parentid: number; content: string; user: string }>;
		categories?: Array<{ title: string }>;
	}

	// 获取上传文件
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
	}).then(({ data }) => (data?.query?.pages as FileInfoPage[] | undefined)?.filter((page) => page.revisions[0].parentid === 0));

	if (fileData) {
		let appendtext = '';
		const badCatUser = new Set<string>(),
			titleUser = new Set<string>(),
			linkUser = new Set<string>(),
			noCatUser = new Set<string>();
		
		// bad title rule
		const titleRegex = /^File:(.+?)\..{3,4}$/,
			nameRegex = /^[a-z0-9.\-@+]+$/i,
			numberRegex = /\d\D+\d.*\d|\d.*\d\D+\d/;
		const badTitleCheck = (title: string): boolean => {
			if (title.includes(' ')) {
				return false;
			}
			const match = titleRegex.exec(title);
			if (!match) {
				return false;
			}
			const name = match[1];
			return name.length > 15 && nameRegex.test(name) && numberRegex.test(name);
		};

		// bad link rule
		const linkRegex = /源地址[:：](.*?)\n/;
		const badLinkCheck = (str: string): string | false => {
			if (!str.includes('源地址')) {
				return false;
			}
			const match = linkRegex.exec(str);
			if (match && match[1]) {
				const sourceAddress = match[1].trim();
				if (sourceAddress && !sourceAddress.toLowerCase().startsWith('http')) {
					return sourceAddress;
				}
			}
			return false;
		};

		await Promise.all(fileData.map(async ({ title, revisions: [{ content, user }], categories }) => {
			// 检查是否不需要用户页通知
			const hasNoBots = noBotsUser.has(user);
			// 检查文件命名
			if (!titleUser.has(user) && !prefixRegex.test(title) && badTitleCheck(title)) {
				titleUser.add(user);
				if (!hasNoBots) {
					await pageEdit(zhapi, `User talk:${user}`, `{{subst:User:星海子/BotMessages/FileName|filename=${title}}}`, '关于您近期上传的文件～', '关于您近期上传的文件');
				}
				appendtext += `\n|-\n|{{user|${user}}} || [[cm:${title}|${title}]] || 文件名 || ||${hasNoBots ? ' {{tlx|bots}}' : ''}`;
			}
			// 检查源地址
			if (!linkUser.has(user)) {
				const foundLink = badLinkCheck(content);
				if (foundLink) {
					linkUser.add(user);
					if (!hasNoBots) {
						await pageEdit(zhapi, `User talk:${user}`, `{{subst:User:星海子/BotMessages/FileLink|filename=${title}|link=<code><nowiki>${foundLink}</nowiki></code>}}`, '关于您近期上传的文件～', '关于您近期上传的文件');
					}
					appendtext += `\n|-\n|{{user|${user}}} || [[cm:${title}|${title}]] || 源地址 || <code><nowiki>${foundLink}</nowiki></code> ||${hasNoBots ? ' {{tlx|bots}}' : ''}`;
				}
			}
			// 获取页面分类
			const categoryData = categories?.map((item) => item.title) || [];
			// 检查无分类
			if (!noCatUser.has(user)) {
				const hasCategory = categoryData.some((cat) => !noCatSet.has(cat));
				if (!hasCategory) {
					noCatUser.add(user);
					if (!hasNoBots) {
						await pageEdit(zhapi, `User talk:${user}`, `{{subst:User:星海子/BotMessages/FileNoCat|filename=${title}}}`, '关于您近期上传的文件～', '关于您近期上传的文件');
					}
					appendtext += `\n|-\n|{{user|${user}}} || [[cm:${title}|${title}]] || 分类 || 无实质分类 ||${hasNoBots ? ' {{tlx|bots}}' : ''}`;
				}
			}
			// 检查错误分类
			if (!badCatUser.has(user)) {
				const badCategories = categoryData.filter((cat) => badCatSet.has(cat));
				const badCategoryLinks = badCategories
					.map((title) => `[[[[:cm:${title}|${title}]]]]`)
					.join('、');
				if (badCategories.length > 0) {
					badCatUser.add(user);
					if (!hasNoBots) {
						await pageEdit(zhapi, `User talk:${user}`, `{{subst:User:星海子/BotMessages/FileCat|filename=${title}|category=${badCategoryLinks}}}`, '关于您近期上传的文件～', '关于您近期上传的文件');
					}
					appendtext += `\n|-\n|{{user|${user}}} || [[cm:${title}|${title}]] || 分类 || ${badCategoryLinks} ||${hasNoBots ? ' {{tlx|bots}}' : ''}`;
				}
			}
		}));
		
		// 输出日志
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