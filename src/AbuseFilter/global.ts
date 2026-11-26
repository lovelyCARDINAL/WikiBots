import moment from 'moment';
import { MediaWikiApi } from 'wiki-saikou';
import type { MwQueryResponse } from '../types/mediawiki.d.ts';
import clientLogin from '../utils/core/clientLogin.ts';
import config from '../utils/core/config.ts';
import { getAbuseFilterDetails } from '../utils/wiki/abuseFilter.ts';

const SITE_LIST = ['en', 'ja', 'lb'] as const;

interface AbuseFilterEntry {
	id: number;
	pattern: string;
	lastedittime: string;
}

const zhapi = new MediaWikiApi({
	baseURL: config.zh.api,
	fexiosConfigs: {
		headers: { 'user-agent': config.useragent },
	},
});

async function getAbuseFilter(api: MediaWikiApi): Promise<AbuseFilterEntry[]> {
	const { data: { query: { abusefilters } } } = await api.post<MwQueryResponse<{ abusefilters: AbuseFilterEntry[] }>>({
		list: 'abusefilters',
		abflimit: 'max',
		abfprop: 'id|pattern|lastedittime',
	}, {
		retry: 50,
	});
	return abusefilters;
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	await clientLogin(zhapi, config.zh.abot.account, config.password);

	const setData = await (async () => {
		const { data: { query: { pages: [{ revisions: [{ content }] }] } } } = await zhapi.post<MwQueryResponse<{ pages: Array<{ revisions: Array<{ content: string }> }> }>>({
			prop: 'revisions',
			titles: 'User:星海子/BotConfig/abuseFilter.json',
			rvprop: 'content',
		}, {
			retry: 20,
		});
		return JSON.parse(content) as Record<string, Record<string, number>>;
	})();
	
	const zhData = await (async () => {
		const ids = Object.keys(setData);
		const data = await getAbuseFilter(zhapi);
		const result: Record<string, { pattern: string; lastedittime: string }> = {};
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
		try {
			const api = new MediaWikiApi({
				baseURL: config[site].api,
				fexiosConfigs: {
					headers: { 'user-agent': config.useragent },
				},
			});
			await clientLogin(api, config[site].abot.account, config.password);

			const ids = new Set(
				Object.entries(setData)
					.filter(([, data]) => Object.hasOwn(data, site))
					.map(([, data]) => data[site]),
			);
			
			const data = await (async () => {
				const origin = await getAbuseFilter(api);
				const result: Array<[number, string]> = [];
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

			await Promise.all(data.map(async ([id, pattern]) => {
				const { formSnippet, action } = await getAbuseFilterDetails(api, id);
				formSnippet.wpFilterRules = pattern;
				if (!action) {
					throw new Error(`Missing form action for ${site} abuse filter ${id}`);
				}
				await api.request
					.post(action, formSnippet, { retry: 50 })
					.then(() => console.log(`Try to update ${site} abuse filter ${id}!`));
			}));
		} catch (error) {
			// Avoid outputting detailed rules for filters.
			console.error(`Error: ${site} abuse filter update failed!`);
			console.error(error);
			e++;
		}
	}));
	if (e) {
		console.log(`${e} error(s) occurred (ignored for ${SITE_LIST.join(', ')}).`);
	}

	console.log(`End time: ${new Date().toISOString()}`);
})();