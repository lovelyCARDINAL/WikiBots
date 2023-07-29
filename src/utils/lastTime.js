import { Buffer } from 'buffer';
import process from 'process';
import { Octokit } from '@octokit/core';
import { load, dump } from 'js-yaml';

const octokit = new Octokit({
	auth: process.env.GITHUB_TOKEN,
});

/**
 * @returns {Promise<Object>}
 */
async function getTimeData(type) {
	try {
		const { data: raw } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
			owner: 'lovelyCARDINAL',
			repo: 'WikiBots',
			path: 'data/time.yaml',
			mediaType: {
				format: 'raw',
			},
		});
		const data = load(raw);
		if (!data[type]) {
			throw new Error(`No last time data of ${type}!`);
		}
		return data;
	} catch (err) {
		console.error(err);
		process.exit(6);
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
	} catch (err) {
		console.error(err);
		process.exit(1);
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