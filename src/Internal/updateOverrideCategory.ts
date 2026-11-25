import { Buffer } from 'buffer';
import process, { env } from 'process';
import { Octokit } from '@octokit/core';
import type { MediaWikiApi } from 'wiki-saikou';
import config from '../utils/config.ts';
import { createAndLogin } from '../utils/createApi.ts';

interface OverrideCategoryConfig {
	cat: string[];
	vtuber_cat: string[];
	[key: string]: unknown;
}

interface CategoryMember {
	title: string;
}

interface RevisionPage {
	revisions?: Array<{ content?: string }>;
}

const octokit = new Octokit({ auth: env.GITHUB_TOKEN });

async function fetchSubcategories(api: MediaWikiApi, cat: string): Promise<string[]> {
	const { data } = await api.post<{ query?: { categorymembers?: CategoryMember[] } }>({
		list: 'categorymembers',
		cmtitle: cat,
		cmprop: 'title',
		cmtype: 'subcat',
		cmlimit: 'max',
	}, {
		retry: 50,
	});
	return (data.query?.categorymembers ?? []).map(({ title }) => title);
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	if (!config.zh.ibot.password) {
		throw new Error('ZH_IBOT is not set');
	}

	const api = await createAndLogin('zh', 'ibot');

	const { data: revData } = await api.post<{ query?: { pages?: RevisionPage[] } }>({
		prop: 'revisions',
		titles: 'User:星海子/BotData/overrideCategory.json',
		rvprop: 'content',
	}, {
		retry: 15,
	});
	const content = revData.query?.pages?.[0]?.revisions?.[0]?.content;
	const setData = JSON.parse(content || '{}') as OverrideCategoryConfig;

	const data: Record<string, unknown> = {};
	for (const key of Object.keys(setData)) {
		if (!key.endsWith('cat') && !key.startsWith('_')) {
			data[key] = setData[key];
		}
	}

	const [catList, vtuberCatList] = await Promise.all([
		Promise.all((setData.cat ?? []).map((cat) => fetchSubcategories(api, cat))),
		Promise.all((setData.vtuber_cat ?? []).map((cat) => fetchSubcategories(api, cat))),
	]);
	data.cat = catList.flat();
	data.vtuber = vtuberCatList.flat().concat(Array.isArray(data.vtuber) ? data.vtuber.filter((item): item is string => typeof item === 'string') : []);

	try {
		const { data: fileData } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
			owner: 'lovelyCARDINAL',
			repo: 'WikiBots',
			path: 'data/overrideCategory.json',
		});
		const sha = 'sha' in fileData ? fileData.sha : undefined;
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
		console.error('ERROR:', error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
	console.log(`End time: ${new Date().toISOString()}`);
})();
