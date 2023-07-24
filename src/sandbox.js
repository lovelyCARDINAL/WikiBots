// @TODO: 若沙盒版本数超过2000，则删除并重建

import moment from 'moment';
import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';

const api = new MediaWikiApi(config.zh.api, { headers: { 'api-user-agent': config.apiuseragent } });

const PAGE_MAP = {
	'Help:沙盒': {
		content: '<noinclude><!-- 请勿删除此行 -->{{沙盒顶部}}<!-- 请勿删除此行 --></noinclude>\n== 请在这行文字底下开始测试 ==',
		summary: '沙盒清理作业。若想保留较长时间，可在[[Special:MyPage/Sandbox|个人沙盒]]进行测试，或查阅页面历史并再次编辑本页。',
	},
	'Template:沙盒': {
		content: '<noinclude><!-- 请勿删除此行 -->{{帮助导航}}{{沙盒顶部}}<!-- 请勿删除此行 --></noinclude>',
		summary: '沙盒清理作业。若想保留较长时间，可在[[Special:MyPage/Sandbox|个人沙盒]]进行测试，或查阅页面历史并再次编辑本页。',
	},
	'Help:沙盒/styles.css': {
		content: '',
		summary: '沙盒清理作业。如有需要请查阅页面历史并再次编辑本页。',
	},
	'Template:沙盒/styles.css': {
		content: '/* [[Category:在模板名字空间下的CSS页面]] */',
		summary: '沙盒清理作业。如有需要请查阅页面历史并再次编辑本页。',
	},
	'模块:Sandbox': {
		content: '',
		summary: '沙盒清理作业。如有长期测试需要请创建以「模块:Sandbox/您的用户名」命名的子页面。',
	},
};

async function pageProtect(title) {
	const { data } = await api.postWithToken('csrf', {
		action: 'protect',
		title,
		protections: 'move=sysop',
		expiry: 'infinite',
		reason: '公共沙盒保护',
		tags: 'Bot',
		watchlist: 'nochange',
	});
	console.log(JSON.stringify(data));
}

async function pageEdit(title) {
	const { data } = await api.postWithToken('csrf', {
		action: 'edit',
		title,
		text: PAGE_MAP[title].content,
		notminor: true,
		bot: true,
		nocreate: true,
		tags: 'Bot',
		summary: PAGE_MAP[title].summary,
		watchlist: 'nochange',
	});
	console.log(JSON.stringify(data));
}

console.log(`Start time: ${new Date().toISOString()}`);

(async () => {
	await api.login(config.zh.abot.name, config.zh.abot.password).then(console.log);

	const { data :{ query: { pages } } } = await api.post({
		prop: 'revisions|info',
		titles: Object.keys(PAGE_MAP).join('|'),
		rvprop: 'content',
		inprop: 'protection',
	});

	await Promise.all(pages.map(async ({ title, revisions: [ { content } ], protection, touched }) => {
		if (protection.length === 0 || protection[0].type !== 'move' || protection[0].level !== 'sysop') {
			await pageProtect(title);
		}
		if (PAGE_MAP[title].content !== content) {
			const minutesDiff = moment().diff(moment(touched), 'minutes');
			minutesDiff > 20 ? await pageEdit(title) : console.log(`${title} was edited ${minutesDiff} minutes ago.`);
		}
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();
