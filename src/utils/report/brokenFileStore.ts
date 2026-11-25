import { Buffer } from 'buffer';
import { env } from 'process';
import { Octokit } from '@octokit/core';
import { REPORT_PAGEID, safePost, SIZE_LIMIT, sleep, zhapi, type CacheEntry } from './brokenFileClient.ts';

const GH_OWNER = 'lovelyCARDINAL';
const GH_REPO = 'WikiBots';
const GH_PATH = 'data/brokenFiles.json';
const octokit = new Octokit({ auth: env.GITHUB_TOKEN });

export const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

export async function pushData(imgData: Record<string, CacheEntry>): Promise<boolean> {
	if (!env.GITHUB_TOKEN) {
		console.warn('WARN: 未设置 GITHUB_TOKEN，跳过数据提交');
		return false;
	}
	const content = Buffer.from(JSON.stringify(imgData, null, '\t'), 'utf-8').toString('base64');

	for (let attempt = 0; attempt < 3; attempt++) {
		let sha: string | undefined;
		try {
			const res = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
				owner: GH_OWNER, repo: GH_REPO, path: GH_PATH,
			});
			sha = 'sha' in res.data ? res.data.sha : undefined;
		} catch (error: unknown) {
			if ((error as { status?: number } | undefined)?.status !== 404) {
				throw error;
			}
			console.log('数据文件不存在，本次将创建');
		}

		try {
			await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
				owner: GH_OWNER,
				repo: GH_REPO,
				path: GH_PATH,
				message: 'auto: update broken files data',
				content,
				...sha && { sha },
			});
			return true;
		} catch (error: unknown) {
			if ((error as { status?: number } | undefined)?.status === 409 && attempt < 2) {
				console.warn('提交冲突，重新获取 sha 后重试');
				await sleep(2000);
				continue;
			}
			throw error;
		}
	}
	return false;
}

export async function getIndexTitle(): Promise<string> {
	const { data } = await safePost<{
		query?: { pages?: Record<string, { missing?: boolean; title: string }> };
	}>(zhapi, { prop: 'info', pageids: REPORT_PAGEID }, { label: 'indexinfo' });
	const page = Object.values(data?.query?.pages ?? {})[0];
	if (!page || page.missing) {
		throw new Error(`索引页 pageid=${REPORT_PAGEID} 不存在，请检查 REPORT_PAGEID`);
	}
	return page.title;
}

async function getBaseRevId({ title, pageid }: { title?: string; pageid?: string }): Promise<number | undefined> {
	const { data } = await safePost<{
		query?: { pages?: Record<string, { missing?: boolean; revisions?: Array<{ revid: number }> }> };
	}>(zhapi, {
		prop: 'revisions',
		rvprop: 'ids',
		rvlimit: '1',
		...pageid ? { pageids: pageid } : { titles: title },
	}, { label: 'pageinfo' });
	const page = Object.values(data?.query?.pages ?? {})[0];
	return page && !page.missing ? page.revisions?.[0]?.revid : undefined;
}

export async function editPage({ title, pageid, text, summary }: { title?: string; pageid?: string; text: string; summary: string }): Promise<boolean> {
	const label = title ?? `pageid=${pageid}`;
	const size = bytes(text);
	if (size > SIZE_LIMIT) {
		console.warn(`  ! ${label} 体积 ${size} 字节，已超出软上限 ${SIZE_LIMIT}`);
	}

	for (let attempt = 0; attempt < 3; attempt++) {
		const baserevid = await getBaseRevId({ title, pageid });
		const { data } = await zhapi.postWithToken('csrf', {
			action: 'edit',
			...pageid ? { pageid } : { title },
			text,
			summary,
			bot: true,
			notminor: true,
			tags: 'Bot',
			watchlist: 'nochange',
			...baserevid && { baserevid },
			starttimestamp: Math.floor(Date.now() / 1000),
		}, { retry: 5, noCache: true });

		if (data?.edit?.result === 'Success') {
			console.log(`  ✓ ${label}（${size} 字节）→ revid ${data.edit.newrevid ?? ''}`);
			return true;
		}

		const code = data?.error?.code ?? data?.errors?.[0]?.code;
		const info = data?.error?.info ?? data?.errors?.[0]?.text ?? JSON.stringify(data).slice(0, 300);
		if (code === 'editconflict' && attempt < 2) {
			console.warn(`  ! ${label} 编辑冲突，重新取 baserevid 后重试`);
			await sleep(3000);
			continue;
		}
		if (code === 'ratelimited' && attempt < 2) {
			console.warn(`  ! ${label} 触发限流，15s 后重试`);
			await sleep(15_000);
			continue;
		}
		console.error(`  ✗ ${label} 编辑失败 [${code}] ${info}`);
		if (code === 'contenttoobig') {
			console.error(`    实际 ${size} 字节。可调小 SIZE_LIMIT / GCM_LIMIT 压缩体积`);
		}
		return false;
	}
	return false;
}
