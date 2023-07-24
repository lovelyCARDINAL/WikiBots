import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';
import { getTimeData, editTimeData } from './utils/lastTime.js';
import splitAndJoin from './utils/splitAndJoin.js';

const zhapi = new MediaWikiApi(config.zh.api, { headers: { 'api-user-agent': config.apiuseragent } }),
	cmapi = new MediaWikiApi(config.cm.api, { headers: { 'api-user-agent': config.apiuseragent } });

const titleRegex = new RegExp('^File:(.+?)\\..{3,4}$'),
	nameRegex = new RegExp('^[A-z0-9.\\-@\\+]+$'),
	numberRegex = new RegExp('\\d\\D+\\d.*\\d|\\d.*\\d\\D+\\d'),
	linkRegex = new RegExp('源地址:(.*?)\\n');

function titleRuleTest(title) {
	if (!title.includes(' ')) {
		const match = titleRegex.exec(title);
		if (match) {
			const name = match[1];
			return name.length > 15 && nameRegex.test(name) && numberRegex.test(name);
		}
	}
	return false;
}

function linkRuleTest(str) {
	if (!str.includes('源地址')) {
		return false;
	}
	const match = linkRegex.exec(str);
	if (match && match[1]) {
		const sourceAddress = match[1].trim();
		if (sourceAddress && !sourceAddress.startsWith('http')) {
			return sourceAddress;
		}
	}
	return false;
}

async function pageEdit(title, text, summary, sectiontitle) {
	const { data } = await zhapi.postWithToken('csrf', {
		action: 'edit',
		title,
		sectiontitle,
		section: 'new',
		text,
		tags: 'Bot',
		summary,
		watchlist: 'nochange',
		bot: true,
	});
	console.log(JSON.stringify(data));
}

console.log(`Start time: ${new Date().toISOString()}`);

(async () => {
	await zhapi.login(config.zh.bot.name, config.zh.bot.password).then(console.log);

	const { data: { query: { pages: [ { revisions: [ { content } ] } ] } } } = await zhapi.post({
		prop: 'revisions',
		titles: 'User:星海子/IncorrectFileInfo.json',
		rvprop: 'content',
	});
	const setting = JSON.parse(content);
	const catData = await (async() => {
		const set = new Set(),
			prefixes = [ 'Category:', '分类:', 'Category:作者:', '分类:作者:' ],
			overridePrefixes = [ 'Category:', '分类:' ],
			categoryNames = setting.category,
			overrideNames = setting.override;
		await Promise.all(categoryNames.map((categoryName) => {
			Promise.all(prefixes.map((prefix) => {
				set.add(`[[${prefix}${categoryName}]]`);
			}));
		}));
		await Promise.all(overrideNames.map((overrideName) => {
			Promise.all(overridePrefixes.map((prefix) => {
				set.delete(`[[${prefix}${overrideName}]]`);
			}));
		}));
		return Array.from(set);
	})();
	const prefixRegex = new RegExp(`File:(?:${setting.prefix.join('|')})`);
	const noBotsUser = await (async () => {
		const { data: { query: { pages } } } = await zhapi.post({
			prop: 'revisions',
			titles: 'Template:Bots',
			generator: 'transcludedin',
			rvprop: 'content',
			gtiprop: 'title',
			gtinamespace: '3',
			gtilimit: 'max',
		});
		const set = new Set();
		const regex = /{{(?:[Nn]obots|[Bb]ots\|(?:allow=none|deny=.*?机娘星海酱.*?|optout=all|optout=.*?fileInfo.*?|deny=all))}}/;
		await Promise.all(pages.map((page) => {
			const user = page.title.replace('User talk:', ''),
				{ content } = page.revisions[0];
			if (regex.test(content.replace(/\s\n/g, ''))) {
				set.add(user);
			}
		}));
		return set;
	})();

	const lastTime = await getTimeData();
	const leend = lastTime['file-info'],
		lestart = new Date(Date.now() - 5 * 60 * 1000).toISOString();

	await cmapi.login(config.cm.bot.name, config.cm.bot.password).then(console.log);

	const fileData = await (async () => {
		const { data: { query: { logevents } } } = await cmapi.post({
			list: 'logevents',
			formatversion: 'latest',
			leprop: 'title|ids',
			leaction: 'upload/upload',
			lelimit: 'max',
			leend,
			lestart,
		});
		const titleData = logevents
			.filter((item) => item.pageid !== 0)
			.map((item) => item.title);
		const titlesGroup = splitAndJoin(titleData, 500);
		const result = await Promise.all(titlesGroup.map(async(titles) => {
			const { data: { query:{ pages } } } = await cmapi.post({
				prop: 'revisions',
				titles,
				rvprop: 'content|ids|user',
			});
			return pages.filter((page) => page.revisions[0].parentid === 0);
		}));
		return [].concat(...result);
	})();

	let appendtext = '';
	const catUser = new Set(),
		titleUser = new Set(),
		linkUser = new Set();
	await Promise.all(fileData.map(async(item) => {
		const { title, revisions: [ { content, user } ] } = item;
		
		if (!titleUser.has(user) && !prefixRegex.test(title) && titleRuleTest(title)) {
			titleUser.add(user);
			if (!noBotsUser.has(user)) {
				await pageEdit(`User talk:${user}`, `{{subst:User:星海子/BotMessages/FileName|filename=${title}}}`, '关于您近期上传的文件～', '关于您近期上传的文件');
			}
			appendtext += `\n|-\n|{{user|${user}}} || [[cm:${title}|${title}]] || 文件名 || ||${noBotsUser.has(user) ? ' {{tlx|bots}}' : ''}`;
		}

		if (!catUser.has(user)) {
			const foundCat = catData.find((cat) => content.includes(cat));
			if (foundCat) {
				catUser.add(user);
				if (!noBotsUser.has(user)) {
					await pageEdit(`User talk:${user}`, `{{subst:User:星海子/BotMessages/FileCat|filename=${title}|category=<code><nowiki>${foundCat}</nowiki></code>}}`, '关于您近期上传的文件～', '关于您近期上传的文件');
				}
				appendtext += `\n|-\n|{{user|${user}}} || [[cm:${title}|${title}]] || 分类 || <code><nowiki>${foundCat}</nowiki></code> ||${noBotsUser.has(user) ? ' {{tlx|bots}}' : ''}`;
			}
		}

		if (!linkUser.has(user)) {
			const foundLink = linkRuleTest(content);
			if (foundLink) {
				linkUser.add(user);
				if (!noBotsUser.has(user)) {
					await pageEdit(`User talk:${user}`, `{{subst:User:星海子/BotMessages/FileLink|filename=${title}|link=<code><nowiki>${foundLink}</nowiki></code>}}`, '关于您近期上传的文件～', '关于您近期上传的文件');
				}
				appendtext += `\n|-\n|{{user|${user}}} || [[cm:${title}|${title}]] || 源地址 || <code><nowiki>${foundLink}</nowiki></code> ||${noBotsUser.has(user) ? ' {{tlx|bots}}' : ''}`;
			}
		}
	}));

	if (appendtext) {
		const { data } = await zhapi.postWithToken('csrf', {
			action: 'edit',
			pageid: '541069',
			summary: 'log: file-info',
			appendtext,
			tags: 'Bot',
			bot: true,
			minor: true,
			watchlist: 'nochange',
		});
		console.log(JSON.stringify(data));
	}

	await editTimeData(lastTime, 'file-info', lestart);

	console.log(`End time: ${new Date().toISOString()}`);
})();
