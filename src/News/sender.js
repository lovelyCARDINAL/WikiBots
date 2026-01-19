import { env } from 'process';
import moment from 'moment';
import { MediaWikiApi } from 'wiki-saikou';
import config from '../utils/config.js';

const type = env.TYPE;
const api = new MediaWikiApi(config.zh.api, {
	headers: { 'user-agent': config.useragent },
});

const getSectionTitle = () => {
	const previousMonth = moment().subtract(1, 'month');
	const year = previousMonth.year();
	const month = previousMonth.month() + 1;

	const toChineseNumber = (num) => {
		const chineseNumbers = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
		return num
			.toString()
			.split('')
			.map((digit) => chineseNumbers[digit])
			.join('');
	};

	const toChineseMonth = (m) => {
		const chineseMonths = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
		return chineseMonths[m - 1];
	};

	const zhYear = toChineseNumber(year);
	const zhMonth = toChineseMonth(month);

	return `《[[萌娘百科:萌娘百科月报|萌娘百科月报]]》[[萌娘百科:萌娘百科月报/${year}年${month}月|${zhYear}年${zhMonth}月号]]`;
};

async function getPagelist() {
	const { data: { query: { pages: [{ revisions: [{ content }] }] } } } = await api.post({
		prop: 'revisions',
		pageids: '488029',
		rvprop: 'content',
		rvsection: '1',
	}, {
		retry: 15,
	});
	const regex = /\[\[(User[ _]talk:.*?)\]\]/gi;
	const matches = [...content.matchAll(regex)];
	return matches.map((match) => match[1]);
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	await api.login(
		config.zh.bot.name,
		config.zh.bot.password,
		undefined,
		{ retry: 25, noCache: true },
	).then(console.log);

	const sectiontitle = getSectionTitle();

	const sendNews = async (title) => {
		const { data } = await api.postWithToken('csrf', {
			action: 'edit',
			title,
			section: 'new',
			sectiontitle,
			text: '{{subst:User:星海子/月报}}',
			tags: 'Bot',
			summary: '您有一份新的月报，请注意查收！ ',
			watchlist: 'nochange',
			bot: true,
		}, {
			retry: 50,
		});
		console.log(JSON.stringify(data));
	};

	switch (type) {
		case '0':
		default:
			console.log(sectiontitle);
			await sendNews('User talk:星海子/月报');
			break;
		case '1':
			Promise.all((await getPagelist()).map(async (title) => {
				await sendNews(title);
			}));
			break;
	}

	console.log(`End time: ${new Date().toISOString()}`);
})();