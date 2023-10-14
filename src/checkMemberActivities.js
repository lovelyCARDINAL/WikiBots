import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import config from './utils/config.js';

const api = new MediaWikiApi(config.zh.api, {
	headers: { 'api-user-agent': config.apiuseragent },
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

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	await api.login(
		config.zh.abot.name,
		config.zh.abot.password,
		undefined,
		{ retry: 25, noCache: true },
	).then(console.log);

	const pageids = ['490856'];

	await Promise.all(pageids.map(async (pageid) => {
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
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();
