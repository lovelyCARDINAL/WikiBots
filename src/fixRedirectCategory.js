import moment from 'moment';
import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import config from './utils/config.js';

const SITE_LIST = ['zh', 'cm'];

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	const zhapi = new MediaWikiApi(config.zh.api, { headers: { 'api-user-agent': config.apiuseragent } });
	await zhapi.login(config.zh.bot.name, config.zh.bot.password).then(console.log);

	const userlist = await (async () => {
		// 获取延确或优编及以上用户
		const { data: { query: { allusers } } } = await zhapi.post({
			list: 'allusers',
			augroup: ['sysop', 'bot', 'patroller', 'honoredmaintainer', 'goodeditor', 'extendedconfirmed', 'staff'],
			aulimit: 'max',
		}, {
			retry: 10,
		});
		return allusers.map(({ name }) => name);
	})();
	console.info(`共${userlist.length}个延确或优编及以上用户`);
	
	await Promise.all(SITE_LIST.map(async (site) => {
		let api;
		if (site === 'zh') {
			api = zhapi;
		} else {
			api = new MediaWikiApi(config[site].api, { headers: { 'api-user-agent': config.apiuseragent } });
			await api.login(config[site].bot.name, config[site].bot.password).then(console.log);
		}

		// 获取已重定向分类
		let { data: { query: { pages } } } = await api.post({
			prop: 'categoryinfo|info|revisions',
			generator: 'categorymembers',
			inprop: 'varianttitles',
			rvprop: 'timestamp|user',
			gcmtitle: 'Category:已重定向的分类',
			gcmprop: 'ids|title',
			gcmtype: 'subcat',
			gcmlimit: 'max',
		}, {
			retry: 10,
		});

		// 获取尚未清空的已重定向分类
		pages = pages.filter(({ categoryinfo: { pages, files, subcats } }) => pages + files + subcats > 0);
		console.info(`${site}: ${pages.length}个已重定向分类尚未清空`);
		if (pages.length === 0) {
			console.log(`${site}: 没有需要修复的已重定向分类`);
			return;
		}

		// 判断最后编辑者是否为延确或优编以上，或者最后编辑时间是否超过3天
		pages = pages.filter(({ revisions: [{ user, timestamp }] }) => userlist.includes(user) || moment(timestamp).isBefore(moment().subtract(3, 'days')));
		console.info(`${site}: ${pages.length}个已重定向分类符合自动修复条件`);

		// 获取全部重定向目标
		const { data: { query: { redirects } } } = await api.post({
			redirects: true,
			pageids: pages.map(({ pageid }) => pageid),
		});

		const contentData = {};
		await Promise.all(pages.map(async ({ title, varianttitles }) => {
			// 获取重定向目标
			const target = redirects.find(({ from }) => from === title)?.to.replace('Category:', '');

			// 获取变体列表和正则
			const variant = Object.values(varianttitles).map((item) => item.replace(/Category:|分类:|分類:/, ''));
			const variantRegex = variant
				.map((item) => item
					.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
					.replaceAll(/ /g, '[ _]'))
				.join('|');

			// 获取分类成员和内容
			const { data: { query: { pages: members } } } = await api.post({
				prop: 'revisions',
				generator: 'categorymembers',
				rvprop: 'content',
				gcmtitle: title,
				gcmlimit: 'max',
			}, {
				retry: 10,
			});

			await Promise.all(members.map(({ pageid, revisions: [{ content }] }) => {
				let wikitext = contentData?.[pageid]?.content || content;
				// 分类文本替换
				wikitext = wikitext.replaceAll(
					new RegExp(`\\s*(Category|分类|分類|Cat):(?:${variantRegex})\\s*(?=[\\|\\]])`, 'ig'),
					`$1:${target}`,
				);

				if (site === 'zh') {
					// 声优
					wikitext = wikitext.replaceAll(
						new RegExp(`(\\|\\s*(?:声优|聲優|配音)\\s*=\\s*)(?:${variantRegex})(?=\\s*[\\|\\}])`, 'ig'),
						`$1${target}`,
					);
					
					wikitext = Parser.parse(wikitext);
					// {{萌点}}
					for (const temp of wikitext.querySelectorAll('template#Template:萌点, template#Template:萌點')) {
						for (const arg of temp.getAllArgs()) {
							const argArrary = arg.value.split(/[,，]/);
							if (variant.includes(argArrary?.[0].trim())) {
								switch (argArrary.length) {
									case 1:
										temp.setValue(arg.name, `${target},${arg.value}`);
										break;
									case 2:
										['del', '黑幕', 'heimu', '加粗', 'b'].includes(argArrary[1].trim())
											? temp.setValue(arg.name, `${target},${arg.value}`)
											: temp.setValue(arg.name, `${target},${argArrary[1]}`);
										break;
									case 3:
										temp.setValue(arg.name, `${target},${argArrary[1]},${argArrary[2]}`);
										break;
								}
							}
						}
					}

					// {{Cate}}
					for (const temp of wikitext.querySelectorAll('template#Template:Cate')) {
						for (const arg of temp.getAllArgs()) {
							if (variant.includes(arg.value.trim()) && arg.name !== '1') {
								temp.setValue(arg.name, target);
							}
						}
					}
				}

				if (site === 'cm') {
					wikitext = Parser.parse(wikitext);
					// {{虚拟角色/作}}
					const temp1 = wikitext.querySelector('template#Template:虚拟角色/作, template#Template:虛擬角色/作');
					if (temp1) {
						for (const arg of temp1.getAllArgs()) {
							if (variant.includes(`${arg.value.trim()}角色`) && arg.name !== 'more') {
								temp1.setValue(arg.name, target.replace(/角色$/, ''));
							}
						}
					}

					// {{作品}}
					const temp2 = wikitext.querySelector('template#Template:作品');
					if (temp2) {
						for(const arg of temp2.getAllArgs()) {
							if(variant.includes(arg.value.trim()) && arg.name !== '1') {
								temp2.setValue(arg.name, target);
							}
						}
					}
				}

				// 保存
				contentData[pageid] ||= {};
				contentData[pageid].content = wikitext.toString();
				contentData?.[pageid]?.summary
					? contentData[pageid].summary += `，[[${title.replace('Category:', 'Cat:')}]] → [[Cat:${target}]]`
					: contentData[pageid].summary = `修复分类重定向：[[${title.replace('Category:', 'Cat:')}]] → [[Cat:${target}]]`;
				console.log(`${site} ${pageid}: ${title} → ${target}`);
			}));
		}));

		await Promise.all(Object.entries(contentData).map(async ([pageid, { content: text, summary }]) => {
			await api.postWithToken('csrf', {
				action: 'edit',
				pageid,
				text,
				summary,
				minor: true,
				bot: true,
				nocreate: true,
				tags: 'Bot',
				watchlist: 'nochange',
			}, {
				retry: 10,
				noCache: true,
			}).then(({ data }) => console.log(JSON.stringify(data)));
		}));
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();
