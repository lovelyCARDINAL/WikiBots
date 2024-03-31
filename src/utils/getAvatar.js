import { Buffer } from 'buffer';
import { env } from 'process';
import { Octokit } from '@octokit/core';
import readData from './readData.js';

const octokit = new Octokit({ auth: env.GITHUB_TOKEN });

/**
 * @param {Object} idsData
 **/
async function uploadData(idsData) {
	try {
		const { data: { sha } } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
			owner: 'lovelyCARDINAL',
			repo: 'WikiBots',
			path: 'data/userIds.json',
		});
		await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
			owner: 'lovelyCARDINAL',
			repo: 'WikiBots',
			path: 'data/userIds.json',
			message: 'auto: update userids data',
			content: Buffer.from(JSON.stringify(idsData, null, '\t'), 'utf-8').toString('base64'),
			sha,
		});
		console.log('SUCCESS!');
	} catch (error) {
		console.error('ERROR:', error.message);
	}
}

/**
 * @param {import('../src').MediaWikiApi} api
 * @param {Array<string>} userusers
 */
async function getAvatar(api, ususers) {
	const { data: { query: { users } } } = await api.post({
		list: 'users',
		ususers,
	});
	const data = users.reduce((acc, user) => ({ ...acc, [user.name]: user.userid }), JSON.parse(await readData('userIds.json')));
	await uploadData(data);
	return data;
}

export default getAvatar;