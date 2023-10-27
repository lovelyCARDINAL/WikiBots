import process from 'process';
import { load } from 'cheerio';
import moment from 'moment';
import { MediaWikiApi } from 'wiki-saikou';
import clientLogin from './utils/clientLogin.js';
import config from './utils/config.js';

const SITE_LIST = ['en', 'ja', 'lb'];

const zhapi = new MediaWikiApi(config.zh.api, {
	headers: { 'api-user-agent': config.apiuseragent },
});

async function getAbuseFilter(api) {
	const { data: { query: { abusefilters } } } = await api.post({
		list: 'abusefilters',
		abflimit: 'max',
		abfprop: 'id|pattern|lastedittime',
	}, {
		retry: 50,
	});
	return abusefilters;
}

async function getAbuseFilterDetails(api, id) {
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

	await clientLogin(zhapi, config.zh.abot.account, config.password);

	const setData = await (async () => {
		const { data: { query: { pages: [{ revisions: [{ content }] }] } } } = await zhapi.post({
			prop: 'revisions',
			titles: 'User:星海子/BotConfig/abuseFilter.json',
			rvprop: 'content',
		}, {
			retry: 20,
		});
		return JSON.parse(content);
	})();
	
	const zhData = await (async () => {
		const ids = Object.keys(setData);
		const data = await getAbuseFilter(zhapi);
		const result = {};
		data.map(({ id, pattern, lastedittime }) => {
			if (ids.includes(String(id))) {
				if (moment().diff(moment(lastedittime), 'days') < 31) {
					result[id] = {
						pattern,
						lastedittime,
					};
				} else {
					delete setData[String(id)];
				}
			}
		});
		return result;
	})();

	if(!Object.keys(setData).length) {
		console.log('No abuse filter need to update.');
		return;
	}

	let e = 0;
	await Promise.all(SITE_LIST.map(async (site) => {
		const api = new MediaWikiApi(config[site].api, {
			headers: { 'api-user-agent': config.apiuseragent },
		});
		await clientLogin(api, config[site].abot.account, config.password);

		/* eslint-disable no-unused-vars */
		const ids = new Set(
			Object.entries(setData)
				.filter(([_key, data]) => Object.prototype.hasOwnProperty.call(data, site))
				.map(([_key, data]) => data[site]),
		);
		/* eslint-enable no-unused-vars */
		
		const data = await (async () => {
			const origin = await getAbuseFilter(api);
			const result = [];
			const idToKeyMap = new Map(Object.entries(setData).map(([key, value]) => [value[site], key]));

			for (const { id, lastedittime } of origin) {
				if (!ids.has(id)) {
					continue;
				}
				const key = idToKeyMap.get(id);
				if (!key || moment(lastedittime).isAfter(zhData[key].lastedittime)) {
					console.log(`Don't need to update ${site} abuse filter ${id}.`);
					continue;
				}
				result.push([id, zhData[key].pattern]);
			}
			return result;
		})();

		try {
			await Promise.all(data.map(async ([id, pattern]) => {
				const { formSnippet, action } = await getAbuseFilterDetails(api, id);
				formSnippet.wpFilterRules = pattern;
				await api.request
					.post(action, formSnippet, { retry: 50 })
					.then(() => console.log(`Try to update ${site} abuse filter ${id}!`));
			}));
		} catch (error) {
			// Avoid outputting detailed rules for filters.
			console.error(`Error: ${site} abuse filter update failed!`);
			e++;
		}
	}));
	if (e) {
		console.log(`${e} error(s) occurred!`);
		process.exit(1);
	}

	console.log(`End time: ${new Date().toISOString()}`);
})();