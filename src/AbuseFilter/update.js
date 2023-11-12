import process from 'process';
import { load } from 'cheerio';
import moment from 'moment';
import { MediaWikiApi } from 'wiki-saikou';
import clientLogin from '../utils/clientLogin.js';
import config from '../utils/config.js';

const api = new MediaWikiApi(config.zh.api, {
	headers: { 'api-user-agent': config.apiuseragent },
});

async function getAbuseFilter(id) {
	const { data: { query: { abusefilters } } } = await api.post({
		list: 'abusefilters',
		abfstartid: id,
		abfendid: id,
		abflimit: 'max',
		abfprop: 'pattern|lastedittime',
	}, {
		retry: 15,
	});
	return abusefilters[0];
}

async function getAbuseFilterDetails(id) {
	const { response: { data } } = await api.request.get('/index.php', {
		query: {
			title: `Special:AbuseFilter/${id}`,
		},
	});
	const $raw = load(data);
	const $form = $raw('#mw-content-text > form');
	const textInputTypes = [undefined, 'hidden'];
	const checkboxInputTypes = ['checkbox'];
	const acceptableInputTypes = [...textInputTypes, ...checkboxInputTypes];
	return {
		formSnippet: Object.fromEntries([
			...$form.find('input').toArray()
				.map(({ attribs: { name, value, type, checked } }) => [acceptableInputTypes.includes(type) ? name : false, checkboxInputTypes.includes(type) ? !!checked : value]),
			...$form.find('textarea').toArray()
				.map(({ attribs: { name }, children }) => [name, children[0]?.data || '']),
			...$form.find('select').toArray()
				.map((ele) => [ele.attribs.name, ele.childNodes.filter(({ attribs }) => typeof attribs?.selected === 'string')[0]])
				.map(([name, option]) => [name, option?.attribs?.value]),
		].filter(([name]) => name)),
		action: $form.attr('action'),
	};
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	await clientLogin(api, config.zh.abot.account, config.password);

	const { pattern: af70, lastedittime: time70 } = await getAbuseFilter(70);
	if (moment(time70).isBefore(moment().subtract(7, 'days'))) {
		console.log('AbuseFilter 70 is not updated in 7 day.');
		return;
	}

	const { pattern: af18, lastedittime: time18 } = await getAbuseFilter(18);
	if (moment(time18).isAfter(moment(time70))) {
		console.log('AbuseFilter 18 is updated after AbuseFilter 70.');
		return;
	}
	
	const { formSnippet, action } = await getAbuseFilterDetails(18);
	formSnippet.wpFilterRules = af18.replace(/(\/\*\s*下方内容由机器人同步自滥用过滤器70\s*\*\/).+$/s, '$1') + af70.replace(/^.+?\/\*\s*下方内容会被机器人同步到滥用过滤器18\s*\*\//s, '');
	
	try {
		await api.request
			.post(action, formSnippet)
			.then(() => console.log('Try to update AbuseFilter 18!'));
	} catch (error) {
		console.error('Failed to update AbuseFilter 18!');
		process.exit(1);
	}

	console.log(`End time: ${new Date().toISOString()}`);
})();