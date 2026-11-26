import { Buffer } from 'buffer';
import process from 'process';
import { Octokit } from '@octokit/core';
import { load, dump } from 'js-yaml';
import logger, { c } from './logger.ts';

const octokit = new Octokit({
	auth: process.env.GITHUB_TOKEN,
});

const [owner, repo] = (process.env.GITHUB_REPOSITORY || 'lovelyCARDINAL/WikiBots').split('/');
const TIME_PATH = 'data/time.yaml';

async function getTimeData(type?: string): Promise<Record<string, string>> {
	try {
		const { data: raw } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
			owner,
			repo,
			path: TIME_PATH,
			mediaType: {
				format: 'raw',
			},
		});
		const data = load(raw as unknown as string) as Record<string, string>;
		if (type && !data[type]) {
			throw new Error(`No last time data of ${type}!`);
		}
		return data;
	} catch (err) {
		console.error(err);
		process.exit(6);
	}
}

async function editTimeData(
	origin: Record<string, string>,
	type: string,
	value: string,
): Promise<void> {
	const maxRetries = 5;
	try {
		let latestOrigin = origin;
		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			const { data: file } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
				owner,
				repo,
				path: TIME_PATH,
			});
			const fileObj = file as { content?: string; sha?: string };
			if (attempt > 1 && fileObj.content) {
				latestOrigin = load(Buffer.from(fileObj.content, 'base64').toString('utf8')) as Record<string, string>;
			}

			const obj = { ...latestOrigin, [type]: value };
			const content = dump(obj);
			try {
				await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
					owner,
					repo,
					path: TIME_PATH,
					message: `auto: record last run time of ${type}`,
					content: Buffer.from(content, 'utf-8').toString('base64'),
					sha: fileObj.sha,
				});
				logger.success(`Updated ${c.cyan(TIME_PATH)} (${c.yellowBright(type)} = ${c.greenBright(value)})`);
				return;
			} catch (err: unknown) {
				const status = (err as { status?: number } | undefined)?.status;
				if (status === 409 && attempt < maxRetries) {
					logger.warn(`Conflict updating ${TIME_PATH} (attempt ${attempt}/${maxRetries}), retrying...`);
					continue;
				}
				throw err;
			}
		}
	} catch (err) {
		logger.error(`Failed to update ${TIME_PATH}`, err);
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
