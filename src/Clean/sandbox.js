import moment from 'moment';
import { MediaWikiApi } from 'wiki-saikou';
import config from '../utils/config.js';

const api = new MediaWikiApi(config.zh.api, {
	headers: { 'user-agent': config.useragent },
});

const PAGE_MAP = {
	'Help:沙盒': {
		content: '<noinclude><!-- 请勿删除此行 -->{{沙盒顶部}}<!-- 请勿删除此行 --></noinclude>\n== 请在这行文字底下开始测试 ==',
		summary: '沙盒清理作业。若想保留较长时间，可在[[Special:MyPage/Sandbox|个人沙盒]]进行测试，或查阅页面历史并再次编辑本页。',
	},
	'Template:沙盒': {
		content: '<noinclude><!-- 请勿删除此行 -->{{帮助导航}}{{沙盒顶部}} __EXPECTUNUSEDTEMPLATE__ <!-- 请勿删除此行 --></noinclude>',
		summary: '沙盒清理作业。若想保留较长时间，可在[[Special:MyPage/Sandbox|个人沙盒]]进行测试，或查阅页面历史并再次编辑本页。',
	},
	'Help:沙盒/styles.css': {
		content: '._addText { content: "<!-- 请勿删除此行 -->{{沙盒顶部}}<!-- 请勿删除此行 -->" }',
		summary: '沙盒清理作业。如有需要请查阅页面历史并再次编辑本页。',
	},
	'Template:沙盒/styles.css': {
		content: '._addText { content: "<!-- 请勿删除此行 -->{{沙盒顶部}}[[Category:在模板命名空间下的CSS页面]]<!-- 请勿删除此行 -->" }',
		summary: '沙盒清理作业。如有需要请查阅页面历史并再次编辑本页。',
	},
	'Module:Sandbox': {
		content: '',
		summary: '沙盒清理作业。如有长期测试需要请创建以「Module:Sandbox/您的用户名」命名的子页面。',
	},
};

async function pageEdit(title) {
	await api.postWithToken('csrf', {
		action: 'edit',
		title,
		text: PAGE_MAP[title].content,
		notminor: true,
		bot: true,
		tags: 'Bot',
		summary: PAGE_MAP[title].summary,
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

	if (moment().utc().format('dddd') === 'Sunday') {
		await Promise.all(['Help:沙盒', 'Template:沙盒'].map(async (title) => {
			const { data: { query: { pages: [{ revisions: { length } }] } } } = await api.post({
				prop: 'revisions',
				titles: title,
				rvprop: '',
				rvlimit: 'max',
			}, {
				retry: 15,
			});
			console.info(`${title} has ${length} revisions.`);
			if (length > 2000) {
				await api.postWithToken('csrf', {
					action: 'delete',
					title,
					reason: '沙盒清理作业：删除并重建版本过多的公共沙盒。',
					tags: 'Bot',
					watchlist: 'nochange',
				}, {
					retry: 50,
					noCache: true,
				}).then(({ data }) => console.log(JSON.stringify(data)));
				await pageEdit(title);
			}
		}));

		const prefix = ['沙盒/', 'Sandbox/'];
		const deletePages = await Promise.all(prefix.map(async (gapprefix) => {
			const { data: { query: { pages } } } = await api.post({
				prop: 'revisions',
				generator: 'allpages',
				rvprop: 'timestamp',
				gapprefix,
				gapnamespace: '10',
				gaplimit: 'max',
			}, {
				retry: 15,
			});
			return pages
				.filter(({ title, revisions: [{ timestamp }] }) => moment().diff(moment(timestamp), 'days') > 90 && !Object.keys(PAGE_MAP).includes(title))
				.map(({ title, revisions: [{ timestamp }] }) => [title, timestamp]);
		})).then((result) => result.flat());
		console.info(`There are ${deletePages.length} pages to delete.`);
		await Promise.all(deletePages.map(async ([title, timestamp]) => {
			await api.postWithToken('csrf', {
				action: 'delete',
				title,
				reason: `沙盒清理作业：最后编辑时间 ${timestamp} 超过90日。如有需要请联系管理员恢复页面。`,
				tags: 'Bot',
				watchlist: 'nochange',
			}, {
				retry: 50,
				noCache: true,
			}).then(({ data }) => console.log(JSON.stringify(data)));
		}));
	}

	const { data: { query: { pages } } } = await api.post({
		prop: 'revisions|info',
		titles: Object.keys(PAGE_MAP),
		rvprop: 'content',
		inprop: 'protection',
	}, {
		retry: 15,
	});

	await Promise.all(pages.map(async ({ title, revisions: [{ content }], protection, touched }) => {
		if (protection.length === 0 || protection[0].type !== 'move' || protection[0].level !== 'sysop') {
			await api.postWithToken('csrf', {
				action: 'protect',
				title,
				protections: 'move=sysop',
				expiry: 'infinite',
				reason: '公共沙盒保护',
				tags: 'Bot',
				watchlist: 'nochange',
			}, {
				retry: 50,
				noCache: true,
			}).then(({ data }) => console.log(JSON.stringify(data)));
		}
		if (PAGE_MAP[title].content !== content) {
			const minutesDiff = moment().diff(moment(touched), 'minutes');
			minutesDiff > 20 ? await pageEdit(title) : console.log(`${title} was edited ${minutesDiff} minutes ago.`);
		}
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();
