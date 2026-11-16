import { Buffer } from 'buffer';
import process from 'process';
import { Octokit } from '@octokit/core';
import { load, dump } from 'js-yaml';

const octokit = new Octokit({
	auth: process.env.GITHUB_TOKEN,
});

const [owner, repo] = (process.env.GITHUB_REPOSITORY || 'lovelyCARDINAL/WikiBots').split('/');
const TIME_PATH = 'data/time.yaml';

/**
 * @param {string} [type]
 * @returns {Promise<Record<string, string>>}
 */
async function getTimeData(type) {
	try {
		const { data: raw } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
			owner,
			repo,
			path: TIME_PATH,
			mediaType: {
				format: 'raw',
			},
		});
		const data = load(raw);
		if (type && !data[type]) {
			throw new Error(`No last time data of ${type}!`);
		}
		return data;
	} catch (err) {
		console.error(err);
		process.exit(6);
	}
}

/**
 * @param {Record<string, string>} origin
 * @param {string} type
 * @param {string} string
 */
async function editTimeData(origin, type, string) {
	const maxRetries = 5;
	try {
		let latestOrigin = origin;
		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			const { data: file } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
				owner,
				repo,
				path: TIME_PATH,
			});
			if (attempt > 1 && 'content' in file && file.content) {
				latestOrigin = load(Buffer.from(file.content, 'base64').toString('utf8'));
			}

			const obj = { ...latestOrigin, [type]: string };
			const content = dump(obj);
			try {
				await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
					owner,
					repo,
					path: TIME_PATH,
					message: `auto: record last run time of ${type}`,
					content: Buffer.from(content, 'utf-8').toString('base64'),
					sha: file.sha,
				});
				console.log('SUCCESS!');
				return;
			} catch (err) {
				if (err?.status === 409 && attempt < maxRetries) {
					console.warn(`Conflict updating ${TIME_PATH} (attempt ${attempt}/${maxRetries}), retrying...`);
					continue;
				}
				throw err;
			}
		}
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