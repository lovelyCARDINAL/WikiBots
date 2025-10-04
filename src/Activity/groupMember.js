import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import config from '../utils/config.js';

Parser.config = 'moegirl';

const api = new MediaWikiApi(config.zh.api, {
	headers: { 'user-agent': config.useragent },
});

const time = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();

async function isActive(user) {
	const { data: { query: { usercontribs } } } = await api.post({
		list: 'usercontribs',
		ucuser: user,
		ucnamespace: '*',
		uclimit: '1',
		ucend: time,
	}, {
		retry: 15,
	});
	return !usercontribs.length;
}

async function edit(pageid, text) {
	await api.postWithToken('csrf', {
		action: 'edit',
		pageid,
		text,
		summary: '移除超过180日不活跃的编辑组成员',
		tags: 'Bot',
		notminor: true,
		bot: true,
		nocreate: true,
		watchlist: 'nochange',
	}, {
		retry: 50,
		noCache: true,
	}).then(({ data }) => console.log(JSON.stringify(data)));
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	await api.login(
		config.zh.abot.name,
		config.zh.abot.password,
		undefined,
		{ retry: 25, noCache: true },
	).then(console.log);

	const pageids = {
		signature: [],
		template: ['420215', '582333'],
	};

	// signature
	await Promise.all(pageids.signature.map(async (pageid) => {
		const { data: { parse: { wikitext } } } = await api.post({
			action: 'parse',
			pageid,
			prop: 'wikitext',
		}, {
			retry: 15,
		});

		let lines = wikitext.split('\n');
		await Promise.all(lines.map(async (line) => {
			if (!line.startsWith('#')) {
				return;
			}
			const wikitext = Parser.parse(line);
			// 取最后一个用户页、用户讨论页、用户贡献内部链接中的用户名
			const username = wikitext.querySelectorAll('link')
				?.map(({ name }) => /^(?:(?:user|u|user[ _]talk):[^/]+$|(?:Special|特殊):(?:(?:用[户戶]|使用者)?[贡貢]献|Contrib(?:ution)?s)\/)/i.test(name) && name)
				?.filter(Boolean)
				?.at(-1)
				?.replace(/^user:|u:|user[ _]talk:|(Special|特殊):((用[户戶]|使用者)?[贡貢]献|Contrib(ution)?s)\//i, '');
			if (!username) {
				console.warn(`username not found: ${line}`);
				return;
			}
			if (await isActive(username)) {
				lines = lines.filter((item) => line !== item);
			}
		}));

		const text = lines.join('\n');
		if (text === wikitext) {
			console.log(`No change: ${pageid}`);
			return;
		}
		await edit(pageid, text);
	}));

	// template
	await Promise.all(pageids.template.map(async (pageid) => {
		const { data: { parse: { wikitext, links } } } = await api.post({
			action: 'parse',
			pageid,
			prop: 'wikitext|links',
		}, {
			retry: 15,
		});

		// {{User}}与{{Supu}}均包含User talk内部链接
		const inactive = (await Promise.all(links
			.map(({ ns, title }) => ns === 3 && title)
			.filter(Boolean)
			.map((title) => !title.includes('/') && title.replace('User talk:', ''))
			.map(async (user) => {
				return await isActive(user) && user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			}),
		)).filter(Boolean);

		const content = Parser.parse(wikitext);
		/** @type {Parser.TranscludeToken[]} */
		const templates = content.querySelectorAll('template#Template:Hlist');
		const regex = new RegExp(`{{\\s*(?:User|Supu)\\s*\\|\\s*(?:${inactive.join('|')})\\s*[|}]`, 'i');

		for (const temp of templates) {
			for (const arg of temp.getAllArgs()) {
				if (regex.test(arg.value.trim())) {
					arg.remove();
				}
			}
		}

		const text = content.toString();
		if (text === wikitext) {
			console.log(`No change: ${pageid}`);
			return;
		}
		await edit(pageid, text);
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();
