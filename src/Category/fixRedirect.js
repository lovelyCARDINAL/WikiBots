import moment from 'moment';
import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import config from '../utils/config.js';
import paginate from '../utils/paginate.js';
import parserConfig from '../utils/parserConfig.js';

Parser.config = 'moegirl';
Parser.conversionTable = new Map(parserConfig.conversionTable);

const SITE_LIST = ['zh', 'cm'];

/**
 * Remove a CategoryToken and collapse its trailing newline when it occupied its own line.
 *
 * @param {Parser.CategoryToken} category
 */
function removeCategory(category) {
	const prev = category.previousSibling;
	const next = category.nextSibling;
	const atLineStart = !prev || prev.type === 'text' && /\n$/.test(prev.data);
	if (atLineStart && next?.type === 'text' && next.data.startsWith('\n')) {
		next.replaceData(next.data.slice(1));
	}
	category.remove();
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	const zhapi = new MediaWikiApi({
		baseURL: config.zh.api,
		fexiosConfigs: {
			headers: { 'user-agent': config.useragent },
		},
	});
	await zhapi.login(
		config.zh.bot.name,
		config.zh.bot.password,
		undefined,
		{ retry: 75, noCache: true },
	).then(console.log);

	const userlist = await (async () => {
		// 获取延确或优编及以上用户
		const { data: { query: { allusers } } } = await zhapi.post({
			list: 'allusers',
			augroup: ['sysop', 'bot', 'patroller', 'honoredmaintainer', 'goodeditor', 'extendedconfirmed', 'staff'],
			aulimit: 'max',
		}, {
			retry: 50,
		});
		return allusers.map(({ name }) => name);
	})();
	console.info(`共${userlist.length}个延确或优编及以上用户`);
	
	await Promise.all(SITE_LIST.map(async (site) => {
		try {
			let api;
			if (site === 'zh') {
				api = zhapi;
			} else {
				api = new MediaWikiApi(config[site].api, {
					headers: { 'user-agent': config.useragent },
				});
				await api.login(
					config[site].bot.name,
					config[site].bot.password,
					undefined,
					{ retry: 75, noCache: true },
				).then(console.log);
			}

			// 获取已重定向分类
			let pages = await (async () => {
				const result = [];
				for await (const data of paginate(api, {
					prop: 'categoryinfo|info|revisions',
					generator: 'categorymembers',
					cllimit: 'max',
					inprop: 'varianttitles',
					rvprop: 'timestamp|user',
					gcmtitle: 'Category:已重定向的分类',
					gcmprop: 'ids|title',
					gcmtype: 'subcat',
					gcmlimit: 'max',
				}, {
					retry: 50,
				})) {
					if (data.query?.pages) {
						result.push(...Object.values(data.query.pages));
					}
				}
				return result;
			})();

			// 获取尚未清空的已重定向分类
			pages = pages.filter(({ categoryinfo: { size } }) => size > 0);
			console.info(`${site}: ${pages.length}个已重定向分类尚未清空`);
			if (pages.length === 0) {
				console.log(`${site}: 没有需要修复的已重定向分类`);
				return;
			}

			// 判断最后编辑者是否为延确或优编以上，或者最后编辑时间是否超过3天
			pages = pages.filter(({ revisions: [{ user, timestamp }] }) => userlist.includes(user) || moment(timestamp).isBefore(moment().subtract(3, 'days')));
			console.info(`${site}: ${pages.length}个已重定向分类符合自动修复条件`);
			if (pages.length === 0) {
				return;
			}

			// 获取全部重定向目标
			const { data: { query: { redirects } } } = await api.post({
				redirects: true,
				pageids: pages.map(({ pageid }) => pageid),
			}, {
				retry: 50,
			});

			const contentData = {};
			await Promise.all(pages.map(async ({ title, varianttitles }) => {
				try {
				// 获取重定向目标
					const target = redirects?.find(({ from }) => from === title)?.to.replace('Category:', '');
					if (!target) {
						console.warn(`${site} ${title}：找不到重定向目标`);
						return;
					}

					// 获取变体列表
					const variant = new Set(Object
						.values(varianttitles)
						.map((item) => item.replace(/Category:|分类:|分類:/, '')),
					);
					const variantList = [...variant.add(...Array.from(variant).map((item) => item.replaceAll(' ', '_')))];

					// 获取分类成员和内容
					const members = await (async () => {
						const result = [];
						for await (const data of paginate(api, {
							prop: 'revisions',
							generator: 'categorymembers',
							rvprop: 'content',
							gcmtitle: title,
							gcmlimit: '500',
						}, {
							retry: 50,
						})) {
							if (data?.query?.pages) {
								result.push(...Object.values(data.query.pages));
							}
						}
						return result;
					})();

					await Promise.all(members.map(({ pageid, revisions: [{ content }] }) => {
						const wikitext = Parser.parse(contentData?.[pageid]?.content || content);

						// 分类
						const targetName = Parser.normalizeTitle(`Category:${target}`).title;
						const variantNames = new Set(Array.from(variant, (item) => Parser.normalizeTitle(`Category:${item}`).title));
						const categories = wikitext.querySelectorAll('category');
						let targetCategory = categories.find((cat) => Parser.normalizeTitle(cat.name).title === targetName);
						for (const category of categories) {
							if (!variantNames.has(Parser.normalizeTitle(category.name).title)) {
								continue;
							}
							if (targetCategory) {
								if (!targetCategory.sortkey && category.sortkey) {
									targetCategory.setSortkey(category.sortkey);
								}
								removeCategory(category);
							} else {
								category.setTarget(`Category:${target}`);
								targetCategory = category;
							}
						}

						if (site === 'zh') {
							// 声优
							/** @type {Parser.ParameterToken | undefined} */
							const param = wikitext.querySelector('parameter:regex("name, /^(?:声优|聲優|配音)$/")');
							if (param) {
								const value = param.value.trim();
								const newValue = target.replace('配音角色', '');
								if (variantList.includes(`${Parser.normalizeTitle(value).title}配音角色`)) {
									param.setValue(param.lastChild.text().replace(value, newValue));
								}
							}
					
							// {{萌点}}
							for (const temp of wikitext.querySelectorAll('template:regex(name, /^Template:萌[点點]$/)')) {
								for (const arg of temp.getAllArgs()) {
									const argArrary = arg.value.split(/[,，]/);
									const normalizeValue = Parser.normalizeTitle(argArrary?.[0].trim()).title;
									if (variantList.includes(normalizeValue)) {
										switch (argArrary.length) {
											case 1:
												temp.setValue(arg.name, `${target},${arg.value}`);
												break;
											case 2:
												['del', '黑幕', 'heimu', '加粗', 'b'].includes(argArrary[1].trim())
													? temp.setValue(arg.name, `${target},${arg.value}`)
													: target === argArrary[1]
														? temp.setValue(arg.name, `${target}`)
														: temp.setValue(arg.name, `${target},${argArrary[1]}`);
												break;
											case 3:
												target === argArrary[1]
													? temp.setValue(arg.name, `${target},${argArrary[2]}`)
													: temp.setValue(arg.name, `${target},${argArrary[1]},${argArrary[2]}`);
												break;
										}
									}
								}
							}

							// {{Cate}}
							for (const temp of wikitext.querySelectorAll('template#Template:Cate')) {
								for (const arg of temp.getAllArgs()) {
									const normalizeValue = Parser.normalizeTitle(arg.value.trim()).title;
									if (variantList.includes(normalizeValue) && arg.name !== '1') {
										temp.setValue(arg.name, target);
									}
								}
							}
						}

						if (site === 'cm') {
							// {{虚拟角色/作}}
							/** @type {Parser.TranscludeToken | undefined} */
							const temp1 = wikitext.querySelector('template:regex(name, /^Template:[虚虛][拟擬]角色\\/作$/)');
							if (temp1) {
								for (const arg of temp1.getAllArgs()) {
									if (variantList.includes(`${arg.value.trim()}角色`) && arg.name !== 'more') {
										temp1.setValue(arg.name, target.replace(/角色$/, ''));
									}
								}
							}

							// {{作品}}
							/** @type {Parser.TranscludeToken | undefined} */
							const temp2 = wikitext.querySelector('template#Template:作品');
							if (temp2) {
								for(const arg of temp2.getAllArgs()) {
									if(variantList.includes(arg.value.trim()) && arg.name !== '1') {
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
				} catch (error) {
					console.error(`${site} ${title} 处理失败:`, error?.message || error);
					process.exitCode = 1;
				}
			}));

			await Promise.all(Object.entries(contentData).map(async ([pageid, { content: text, summary }]) => {
				try {
					const { data } = await api.postWithToken('csrf', {
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
						retry: 50,
						noCache: true,
					});
					console.log(JSON.stringify(data));
					if (data?.edit?.result && data.edit.result !== 'Success') {
						console.error(`${site} ${pageid} 编辑未成功:`, JSON.stringify(data));
						process.exitCode = 1;
					}
				} catch (error) {
					console.error(`${site} ${pageid} 编辑失败:`, error?.message || error);
					process.exitCode = 1;
				}
			}));
		} catch (error) {
			console.error(`${site} 执行失败:`, error?.message || error);
			process.exitCode = 1;
		}
	}));

	console.log(`End time: ${new Date().toISOString()}`);
})();
