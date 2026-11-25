import { SIZE_LIMIT } from './brokenFileClient.ts';
import { bytes } from './brokenFileStore.ts';

export const CATEGORY = 'Category:含有受损文件链接的页面';
const SUBPAGE_PREFIX = '萌娘百科:受损文件详细信息';
const TIME_LOCAL = '{{subst:#time:Y年n月j日 (D) H:i (T)}}';
const TIME_UTC = '{{subst:#time:Y年n月j日 (D) H:i (T)|||1}}';

const FILE_TYPES = [
	{ key: '图像', ext: ['png', 'gif', 'jpg', 'jpeg', 'webp', 'svg', 'jp2'] },
	{ key: '音频', ext: ['mp3', 'ogg', 'oga', 'flac', 'opus', 'wav', 'midi', 'mid'] },
	{ key: '视频', ext: ['webm', 'ogv', 'mpg', 'mpeg'] },
	{ key: '文档', ext: ['pdf'] },
	{ key: '字体', ext: ['ttf', 'woff2'] },
	{ key: '其他', ext: [] },
];
export const TYPE_ORDER = FILE_TYPES.map(({ key }) => key);
const EXT_TO_TYPE = new Map(FILE_TYPES.flatMap(({ key, ext }) => ext.map((e) => [e, key])));

export interface PageFileEntry {
	title: string;
	ns: number;
	images: Record<string, string>;
}

export interface BrokenFileRow {
	title: string;
	ns: number;
	files: Array<{ name: string; status: string }>;
}

export interface VolumeStat {
	type: string;
	files: number;
	pages: number;
	volumes: string[];
}

export const volumeTitle = (type: string, index: number, total: number): string => total > 1
	? `${SUBPAGE_PREFIX}/${type} ${index}`
	: `${SUBPAGE_PREFIX}/${type}`;

function typeOf(fileTitle: string): string {
	const name = String(fileTitle).replace(/^(?:File|Image|Media|文件|图像|媒体)\s*:\s*/i, '');
	const dot = name.lastIndexOf('.');
	if (dot < 0 || dot === name.length - 1) {
		return '其他';
	}
	return EXT_TO_TYPE.get(name.slice(dot + 1).toLowerCase()) ?? '其他';
}

export function groupByType(pageData: Record<number, PageFileEntry>): Map<string, BrokenFileRow[]> {
	const perType = new Map<string, Map<string, BrokenFileRow>>(TYPE_ORDER.map((key) => [key, new Map()]));
	for (const { title, ns, images } of Object.values(pageData)) {
		for (const [name, status] of Object.entries(images)) {
			const bucket = perType.get(typeOf(name))!;
			if (!bucket.has(title)) {
				bucket.set(title, { title, ns, files: [] });
			}
			bucket.get(title)!.files.push({ name, status });
		}
	}
	const sorted = new Map<string, BrokenFileRow[]>();
	for (const key of TYPE_ORDER) {
		const rows = [...perType.get(key)!.values()];
		rows.forEach((row) => row.files.sort((a, b) => a.name.localeCompare(b.name, 'zh')));
		rows.sort((a, b) => a.ns - b.ns || a.title.localeCompare(b.title, 'zh'));
		sorted.set(key, rows);
	}
	return sorted;
}

export function renderBlock({ title, ns, files }: BrokenFileRow): string {
	const rowspan = files.length;
	const namespace = `data-sort-value="${ns}"|${ns === 0 ? '（主）' : `{{ns:${ns}}}`}`;
	const results = files.map(({ name, status }) => `|[[cm:${name}|${name}]]||${status}\n|-`).join('\n');
	return rowspan === 1
		? `|[[${title}]]\n|${namespace}\n${results}\n`
		: `|rowspan=${rowspan}|[[${title}]]\n|rowspan=${rowspan} ${namespace}\n${results}\n`;
}

export function packVolumes(blocks: string[], capacity: number): string[][] {
	const volumes: string[][] = [];
	let current: string[] = [];
	let size = 0;
	for (const block of blocks) {
		const len = bytes(block);
		if (len > capacity) {
			console.warn(`  ! 单个页面块即有 ${len} 字节，超过单卷容量 ${capacity}，将独占一卷（可能被 contenttoobig 拒绝）`);
		}
		if (current.length && size + len > capacity) {
			volumes.push(current);
			current = [];
			size = 0;
		}
		current.push(block);
		size += len;
	}
	if (current.length) {
		volumes.push(current);
	}
	return volumes.length ? volumes : [ [] ];
}

export function volumeText({ type, index, total, blocks, indexTitle }: { type: string; index: number; total: number; blocks: string[]; indexTitle: string }): string {
	const nav: string[] = [];
	if (index > 1) {
		nav.push(`[[${volumeTitle(type, index - 1, total)}|← 上一卷]]`);
	}
	nav.push(`[[${indexTitle}|报告索引]]`);
	if (index < total) {
		nav.push(`[[${volumeTitle(type, index + 1, total)}|下一卷 →]]`);
	}

	return `* 本页面为[[U:星海-interfacebot|机器人]]生成的[[:${CATEGORY}|受损文件]]详细信息（'''${type}'''${total > 1 ? `，第 ${index}/${total} 卷` : ''}），完成修复的<b>任何用户</b>都可以<b class="plainlinks">[{{fullurl:{{FULLPAGENAME}}|action=edit}} 编辑下方表格]</b>。
* 生成时间：${TIME_LOCAL}｜${TIME_UTC}
* ${nav.join(' ｜ ')}

{| class="wikitable sortable plainlinks" style="word-break:break-all" width=100%
|-
! 页面名 || 命名空间 || 文件名 || 文件状态
|-
${blocks.join('')}|}
[[Category:萌娘百科数据报告]][[Category:积压工作]]`;
}

export function buildIndexText({ stats, totalPages, totalFiles }: { stats: VolumeStat[]; totalPages: number; totalFiles: number }): string {
	let text = `* 本页面为[[U:星海-interfacebot|机器人]]生成的[[:${CATEGORY}|受损文件]]报告'''索引'''。因单页大小限制（${Math.round(SIZE_LIMIT / 1000)} KB），明细已按文件类型拆分至下列子页面。
* 生成时间：${TIME_LOCAL}｜${TIME_UTC}
* 合计：'''${totalPages}''' 个页面、'''${totalFiles}''' 个受损文件。

{| class="wikitable sortable"
|-
! 文件类型 || 受损文件数 || 涉及页面数 || 分卷 || 明细子页面
|-
`;
	for (const { type, files, pages, volumes } of stats) {
		if (!volumes.length) {
			continue;
		}
		const links = volumes.length === 1
			? `[[${volumes[0]}|${type}]]`
			: volumes.map((v, i) => `[[${v}|${i + 1}]]`).join(' · ');
		text += `| ${type} || ${files} || ${pages} || ${volumes.length} || ${links}\n|-\n`;
	}
	return `${text}|}
[[Category:萌娘百科数据报告]][[Category:积压工作]]`;
}
