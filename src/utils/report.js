import moment from 'moment';
import Parser from 'wikiparser-node';

/**
 * Load flattened override categories from data/overrideCategory.json.
 *
 * @param {() => Promise<string>} readOverrideJson
 * @returns {Promise<string[]>}
 */
function parseOverrideCategories(raw) {
	const data = JSON.parse(raw);
	return [...data.page, ...data.temp, ...data.cat];
}

/**
 * Build a sortable wikitable report for pages with improvement templates.
 *
 * @param {object} options
 * @param {any[]} options.pages
 * @param {string[]} options.overrideCategory
 * @param {string} options.header
 * @param {string} options.templateSelector
 * @param {string} options.emptyReason
 * @returns {string}
 */
function buildImproveReport({ pages, overrideCategory, header, templateSelector, emptyReason }) {
	let text = `${header}\n\n{| class="wikitable sortable" width=100%\n|-\n! 序号 || 条目名 || 改进方向 || style="width:30%"|部分所属分类 || style="min-width:50px"|代码长度 || style="min-width:80px"|最后版本\n`;
	let count = 1;
	for (const page of pages) {
		const { title, revisions: [{ timestamp, content, size }], categories } = page;
		const category = categories
			?.map(({ title: catTitle }) => catTitle)
			.filter((catTitle) => !overrideCategory.includes(catTitle))
			.map((catTitle) => `[[:${catTitle}]]`)
			.join('，')
			|| 'data-sort-value="*" | <i style="color:red;">无分类！</i>';
		const wikitext = Parser.parse(content.replaceAll('\n', ''));
		const value = wikitext.querySelector(templateSelector)?.getValue()
			|| ['data-sort-value="*" | <i style="color:red;">找不到目标模板</i>'];
		const reason = Object.keys(value)
			.filter((key) => !isNaN(key) && value[key]?.trim())
			.map((key) => value[key]?.trim())
			.join(' • ')
			|| emptyReason;
		const time = `${moment(timestamp).utcOffset('+08:00').format('YYYY-MM-DD HH:mm')} (CST)`;
		text += `|-\n| ${count} || [[${title}]] || ${reason} || ${category} || ${size} || ${time}\n`;
		count++;
	}
	return `${text}|}\n\n[[Category:萌娘百科数据报告]][[Category:积压工作]]`;
}

/**
 * Publish a generated report page via CSRF edit.
 *
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {string} pageid
 * @param {string} text
 */
async function publishReport(api, pageid, text) {
	const { data } = await api.postWithToken('csrf', {
		action: 'edit',
		pageid,
		text,
		summary: '更新数据报告',
		bot: true,
		notminor: true,
		tags: 'Bot',
		watchlist: 'nochange',
	}, {
		retry: 50,
		noCache: true,
	});
	console.log(JSON.stringify(data));
}

export {
	parseOverrideCategories,
	buildImproveReport,
	publishReport,
};
