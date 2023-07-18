import { Octokit } from '@octokit/core';
import { load, dump } from 'js-yaml';
import { Buffer } from 'buffer';
import { env } from 'process';
import readData from './readData.js';

async function getTimeData() {
	const data = await readData('time.yaml');
	return load(data);
}

async function editTimeData(origin, type, string) {
	const octokit = new Octokit({
		auth: env.GITHUB_TOKEN,
	});
	try {
		const { data: { sha } } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
			owner: 'lovelyCARDINAL',
			repo: 'WikiBots',
			path: 'data/time.yaml',
		});

		const obj = { ...origin };
		obj[type] = string;
		if (JSON.stringify(obj) === JSON.stringify(origin)) {
			console.log('No change');
			return;
		}

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