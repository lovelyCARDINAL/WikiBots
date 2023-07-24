import { Buffer } from 'buffer';
import { env } from 'process';
import { Octokit } from '@octokit/core';
import { load, dump } from 'js-yaml';

const octokit = new Octokit({
	auth: env.GITHUB_TOKEN,
});

/**
 * @returns {Promise<Object>}
 */
async function getTimeData() {
	try {
		const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
			owner: 'lovelyCARDINAL',
			repo: 'WikiBots',
			path: 'data/time.yaml',
			mediaType: {
				format: 'raw',
			},
		});
		return load(data);
	} catch (error) {
		console.error('ERROR:', error.message);
	}
}

/**
 * @param {Object} origin
 * @param {string} type
 * @param {string} string
 */
async function editTimeData(origin, type, string) {
	try {
		const { data: { sha } } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
			owner: 'lovelyCARDINAL',
			repo: 'WikiBots',
			path: 'data/time.yaml',
		});

		const obj = { ...origin };
		obj[type] = string;

		const content = dump(obj);
		await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
			owner: 'lovelyCARDINAL',
			repo: 'WikiBots',
			path: 'data/time.yaml',
			message: `auto: record last run time of ${type}`,
			content: Buffer.from(content, 'utf-8').toString('base64'),
			sha,
		});

		console.log('SUCCESS!');
	} catch (error) {
		console.error('ERROR:', error.message);
	}
}

export {
	getTimeData,
	editTimeData,
};

export default {
	getTimeData,
	editTimeData,
};