import { Buffer } from 'buffer';
import { env } from 'process';
import { Octokit } from '@octokit/core';
import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';

const api = new MediaWikiApi(config.zh.api, { headers: { 'api-user-agent': config.apiuseragent || '' } });
const octokit = new Octokit({ auth: env.GITHUB_TOKEN });

console.log(`Start time: ${new Date().toISOString()}`);

(async () => {
	await api.login(config.zh.ibot.name, config.zh.ibot.password).then(console.log);
    
	const { data: { query: { pages: [ { revisions:[ { content } ] } ] } } } = await api.post({
		prop: 'revisions',
		titles: 'User:星海子/OverrideCategory.json',
		rvprop: 'content',
	});
	const setData = JSON.parse(content || '{}');

	const data = {};
	await Promise.all(Object.keys(setData)
		.filter((key) => key !== 'cat' && !key.startsWith('_'))
		.map((key) => {
			data[key] = setData[key];
		}),
	);
	data.cat = await (async () => {
		const result = await Promise.all(setData.cat.map(async (cat) => {
			const { data:{ query: { categorymembers } } } = await api.post({
				list: 'categorymembers',
				cmtitle: cat,
				cmprop: 'title',
				cmtype: 'subcat',
				cmlimit: 'max',
			}, { retry: 10 });
			return categorymembers;
		}));
		return result.flat().map(({ title }) => title);
	})();
    
	try {
		const { data: { sha } } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
			owner: 'lovelyCARDINAL',
			repo: 'WikiBots',
			path: 'data/overrideCategory.json',
		});
		await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
			owner: 'lovelyCARDINAL',
			repo: 'WikiBots',
			path: 'data/overrideCategory.json',
			message: 'auto: update override category data',
			content: Buffer.from(JSON.stringify(data, null, '\t'), 'utf-8').toString('base64'),
			sha,
		});
		console.log('SUCCESS!');
	} catch (error) {
		console.error('ERROR:', error.message);
	}
	console.log(`End time: ${new Date().toISOString()}`);
})();