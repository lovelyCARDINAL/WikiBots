import moment from 'moment';
import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';

const api = new MediaWikiApi(config.zh.api, { headers: { 'api-user-agent': config.apiuseragent } });

async function queryPages(apprefix, apprtype, apprlevel) {
	const { data: { query: { allpages } } } = await api.post({
		list: 'allpages',
		aplimit: 'max',
		apnamespace: '4',
		apprefix,
		apprtype,
		apprlevel,
	});
	return allpages;
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	await api.login(config.zh.abot.name, config.zh.abot.password).then(console.log);

	const prefixlist = [ '萌娘百科月报/20', '萌娘百科月报/月饼/20' ];
	let pagelist = await Promise.all(
		prefixlist.map(
			async (prefix) => {
				const pages = await queryPages(prefix);
				const pagesWithPr = await queryPages(prefix, 'edit', 'patrolleredit');
				const diff = pages.filter((itemA) => !pagesWithPr.some((itemB) => itemA.pageid === itemB.pageid));
				return diff.map((item) => item.title);
			},
		),
	);

	const currentDate = moment().format('YYYY年M月');
	pagelist = pagelist.flat().filter((item) => !item.includes(currentDate));

	if (pagelist.length) {
		await Promise.all(
			pagelist.map(async (title) => {
				const { data } = await api.post({
					action: 'protect',
					title,
					protections: 'edit=patrolleredit|move=sysop',
					expiry: 'infinite',
					reason: '月报存档',
					tags: 'Bot',
					watchlist: 'nochange',
				});
				console.log(JSON.stringify(data));
			}),
		);
	} else {
		console.log('No page to protect.');
	}

	console.log(`End time: ${new Date().toISOString()}`);
})();