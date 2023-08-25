import { env } from 'process';
import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';

const site = env.SITE;
const api = new MediaWikiApi(config[site].api, {
		headers: { 'api-user-agent': config.apiuseragent },
	}),
	main = new MediaWikiApi(config.zh.api, {
		headers: { 'api-user-agent': config.apiuseragent },
	});

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	await Promise.all([
		api.login(config[site].abot.name, config[site].abot.password).then(console.log),
		main.login(config.zh.abot.name, config.zh.abot.password).then(console.log),
	]);

	const titles = await (async () => {
		const { data: { parse: { wikitext } } } = await main.post({
			action: 'parse',
			page: 'User:星海子/BotConfig',
			prop: 'wikitext',
			section: '2',
		}, {
			retry: 10,
		});
		return wikitext.split('\n').slice(2, -1).map((page) => page.trim());
	})();

	await Promise.all(titles.map(async (title) => {
		await api.postWithToken('csrf', {
			action: 'undelete',
			title,
			reason: '用户申请',
			tags: 'Bot',
			watchlist: 'nochange',
		}, {
			retry: 20,
			noCache: true,
		}).then(({ data }) => console.log(JSON.stringify(data)));

		const { data: { query: { pages: [{ missing, revisions }] } } } = await api.post({
			prop: 'revisions',
			titles: title,
			rvprop: 'content|ids',
			rvlimit: 'max',
		}, {
			retry: 10,
		});

		if (missing) {
			console.log(`${title} is missing.`);
			return;
		}

		let undo = undefined,
			undoafter = undefined;
		for (const revision of revisions) {
			if (/{{\s*(?:Template:|T:|模板:|)?\s*即[将將][刪删]除/.test(revision.content)) {
				undo ? undoafter = revision.revid : undo = revision.revid;
				continue;
			}
			break;
		}

		if (undo) {
			await api.postWithToken('csrf', {
				action: 'edit',
				title,
				undo,
				...undoafter && { undoafter },
				summary: '尝试恢复页面后取消即将删除状态',
				tags: 'Bot',
				bot: true,
				nocreate: true,
				minor: true,
				watchlist: 'nochange',
			}, {
				retry: 20,
				noCache: true,
			}).then(({ data }) => console.log(JSON.stringify(data)));
		}
	}));

	await main.postWithToken('csrf', {
		action: 'edit',
		title: 'User:星海子/BotConfig',
		section: '2',
		text: '== Queue ==\n<poem>\n\n</poem>',
		summary: '清空任务队列',
		tags: 'Bot',
		bot: true,
		minor: true,
		nocreate: true,
		watchlist: 'nochange',
	}, {
		retry: 20,
		noCache: true,
	}).then(({ data }) => console.log(JSON.stringify(data)));

	console.log(`End time: ${new Date().toISOString()}`);
})();