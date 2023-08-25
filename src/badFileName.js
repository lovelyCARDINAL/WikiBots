import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';

const zhapi = new MediaWikiApi(config.zh.api, {
		headers: { 'api-user-agent': config.apiuseragent },
	}),
	cmapi = new MediaWikiApi(config.cm.api, {
		headers: { 'api-user-agent': config.apiuseragent },
	});

const MAP = {
	'A-D': ['A', 'B', 'C', 'D'],
	'E-J': ['E', 'F', 'G', 'H', 'I', 'J'],
	'K-N': ['K', 'L', 'M', 'N'],
	'O-T': ['O', 'P', 'Q', 'R', 'S', 'T'],
	'U-Z': ['U', 'V', 'W', 'X', 'Y', 'Z'],
	'0-1': ['0', '1'],
	'2-4': ['2', '3', '4'],
	'5-7': ['5', '6', '7'],
	'8-9': ['8', '9', '!', '?', '.', '&', '$', '@', '~', '(', ')', '%', "'", '"', '=', '-', '+', '。', '，', '？', '—', '“', '”', '…', '☆', '▽', '`', '^'],
};

async function queryFiles(apprefix) {
	const result = [];
	const eol = Symbol();
	let apcontinue = undefined;
	while (apcontinue !== eol) {
		const { data } = await cmapi.post({
			list: 'allpages',
			apprefix,
			apnamespace: '6',
			apfilterredir: 'nonredirects',
			aplimit: 'max',
			...apcontinue && { apcontinue },
		}, {
			retry: 10,
		});
		apcontinue = data.continue ? data.continue.apcontinue : eol;
		result.push(...data.query.allpages.map((page) => [page.title, page.pageid]));
	}
	return result;
}

function isBadTitle(fulltitle) {
	const title = fulltitle.replace(/^File:(.+?)\.(?:ogg|ogv|oga|flac|opus|wav|webm|mp3|png|gif|jpg|jpeg|webp|svg|pdf|jp2|ttf|woff2|mp4)$/i, '$1');
	const isDoubleExtension = /\.\w{3,4}$/.test(title);
	const isSymbolStart = /^\W/.test(title);
	if (isDoubleExtension || isSymbolStart) {
		return true;
	}
	const name = title.replaceAll(/[^\w. ]/g, '');
	return name.length > 15 && /^[\w.]+$/.test(name) && /\d/.test(name);
}

async function updateData(title, text) {
	await zhapi.postWithToken('csrf', {
		action: 'edit',
		title,
		text,
		summary: '更新数据报告',
		bot: true,
		notminor: true,
		nocreate: true,
		tags: 'Bot',
		watchlist: 'nochange',
	}, {
		retry: 20,
		noCache: true,
	}).then(({ data }) => console.log(JSON.stringify(data)));
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	await Promise.all([
		zhapi.login(config.zh.ibot.name, config.zh.ibot.password).then(console.log),
		cmapi.login(config.cm.ibot.name, config.cm.ibot.password).then(console.log),
	]);

	const excludeRegex = await (async () => {
		const { data: { query: { pages: [{ revisions: [{ content }] }] } } } = await zhapi.post({
			prop: 'revisions',
			titles: 'User:星海子/BotConfig/excludeFilePrefix.json',
			rvprop: 'content',
		}, {
			retry: 10,
		});
		const exclude = JSON.parse(content).flat(Infinity).join('|');
		return new RegExp(`^File:(?!${exclude}).+?$`);
	})();

	await Promise.all(Object.entries(MAP).map(async ([key, value]) => {
		const pagelist = await Promise.all(value.map(async (char) => {
			return await queryFiles(char);
		})).then((result) => result.flat().filter((item) => excludeRegex.test(item[0]) && isBadTitle(item[0])));

		let text = '* 本页面为[[U:星海-interfacebot|机器人]]生成的疑似命名不当的文件名，以供维护人员检查。\n* 生成时间：{{subst:#time:Y年n月j日 (D) H:i (T)}}｜{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}\n\n{| class="wikitable sortable center plainlinks" style="word-break:break-all"\n|-\n! width=17%|页面ID !! 文件名 !! width=23%|操作\n';
		for (const [title, pageid] of pagelist) {
			text += `|-\n| ${pageid} || [[:${title}]] || [{{canonicalurl:cm:${title}}} 查看]｜[[Special:链入页面/${title}|链入]]\n`;
		}
		text += '|}\n\n[[Category:萌娘百科数据报告]]';

		await updateData(`萌娘百科:疑似不当文件名数据/${key}`, text);
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();