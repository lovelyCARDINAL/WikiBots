import moment from 'moment';
import type { MediaWikiApi } from 'wiki-saikou';
import { createAndLogin } from '../utils/core/createApi.ts';
import paginate from '../utils/core/paginate.ts';
import { safePostWithToken } from '../utils/core/retry.ts';

const PAGE_MAP: Record<string, { content: string; summary: string }> = {
	'Draft:沙盒': {
		content: '<noinclude><!-- 请勿删除此行 -->{{沙盒顶部}}<!-- 请勿删除此行 --></noinclude>\n== 请在这行文字底下开始测试 ==',
		summary: '沙盒清理作业。若想保留较长时间，可在[[Special:MyPage/Sandbox|个人沙盒]]进行测试，或查阅页面历史并再次编辑本页。',
	},
	'Template:沙盒': {
		content: '<noinclude><!-- 请勿删除此行 -->{{帮助导航}}{{沙盒顶部}} __EXPECTUNUSEDTEMPLATE__ <!-- 请勿删除此行 --></noinclude>',
		summary: '沙盒清理作业。若想保留较长时间，可在[[Special:MyPage/Sandbox|个人沙盒]]进行测试，或查阅页面历史并再次编辑本页。',
	},
	'Draft:沙盒/styles.css': {
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

async function pageEdit(api: MediaWikiApi, title: string) {
	await safePostWithToken(api, 'csrf', {
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
	});
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	const api = await createAndLogin('zh', 'abot');

	if (moment().utc().format('dddd') === 'Sunday') {
		await Promise.all(['Draft:沙盒', 'Template:沙盒'].map(async (title) => {
			const { data } = await api.post<{
				query?: { pages?: Array<{ revisions?: Array<unknown> }> };
			}>({
				prop: 'revisions',
				titles: title,
				rvprop: '',
				rvlimit: 'max',
			}, {
				retry: 15,
			});
			const length = data?.query?.pages?.[0]?.revisions?.length ?? 0;
			console.info(`${title} has ${length} revisions.`);
			if (length > 2000) {
				await safePostWithToken(api, 'csrf', {
					action: 'delete',
					title,
					reason: '沙盒清理作业：删除并重建版本过多的公共沙盒。',
					tags: 'Bot',
					watchlist: 'nochange',
				}, {
					retry: 50,
					noCache: true,
				});
				await pageEdit(api, title);
			}
		}));

		const prefix = ['沙盒/', 'Sandbox/'];
		const deletePages = await Promise.all(prefix.map(async (gapprefix) => {
			const result: Array<[string, string]> = [];
			for await (const data of paginate<{
				query?: { pages?: Array<{ title: string; revisions?: Array<{ timestamp?: string }> }> };
			}>(api, {
				prop: 'revisions',
				generator: 'allpages',
				rvprop: 'timestamp',
				gapprefix,
				gapnamespace: '10',
				gaplimit: 'max',
			})) {
				for (const { title, revisions } of data?.query?.pages ?? []) {
					const timestamp = revisions?.[0]?.timestamp;
					if (timestamp && moment().diff(moment(timestamp), 'days') > 90 && !Object.keys(PAGE_MAP).includes(title)) {
						result.push([title, timestamp]);
					}
				}
			}
			return result;
		})).then((result) => result.flat());
		console.info(`There are ${deletePages.length} pages to delete.`);
		await Promise.all(deletePages.map(async ([title, timestamp]) => {
			await safePostWithToken(api, 'csrf', {
				action: 'delete',
				title,
				reason: `沙盒清理作业：最后编辑时间 ${timestamp} 超过90日。如有需要请联系管理员恢复页面。`,
				tags: 'Bot',
				watchlist: 'nochange',
			}, {
				retry: 50,
				noCache: true,
			});
		}));
	}

	const { data } = await api.post<{
		query?: {
			pages?: Array<{
				title: string;
				revisions?: Array<{ content?: string }>;
				protection?: Array<{ type: string; level: string }>;
				touched?: string;
			}>;
		};
	}>({
		prop: 'revisions|info',
		titles: Object.keys(PAGE_MAP),
		rvprop: 'content',
		inprop: 'protection',
	}, {
		retry: 15,
	});

	await Promise.all((data?.query?.pages ?? []).map(async ({ title, revisions, protection, touched }) => {
		if (!protection?.some((p) => p.type === 'move' && p.level === 'sysop')) {
			await safePostWithToken(api, 'csrf', {
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
			});
		}
		const content = revisions?.[0]?.content;
		if (content === undefined) {
			await pageEdit(api, title);
		} else if (PAGE_MAP[title].content !== content) {
			const minutesDiff = moment().diff(moment(touched), 'minutes');
			if (minutesDiff > 20) {
				await pageEdit(api, title);
			} else {
				console.log(`${title} was edited ${minutesDiff} minutes ago.`);
			}
		}
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();
