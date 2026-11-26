import process from 'process';
import { inspect } from 'util';
import { paint, timestamp } from '../common/logger.ts';

const INSTALLED_KEY = Symbol.for('wikibots.colorConsole');

type GlobalWithColorFlag = typeof globalThis & { [INSTALLED_KEY]?: boolean };

const HIGHLIGHT_RE = /(\[\[[^[\]]+\]\])|(\{\{[^{}]+\}\})|(\d{4}-\d{2}-\d{2}T[\d:.]+Z)|(→)|(\b(?:zh|cm|en|ja|lb|meta)(?=:|\s))|(\b(?:revid|pageid)\s+\d+\b)|(\b\d+(?=\s*(?:个|处|条|字节|page\(s\)|error\(s\))))/g;

function hasAnsi(val: unknown): boolean {
	return typeof val === 'string' && val.includes('\u001B[');
}

function tryColorizeJson(str: string): string | null {
	const trimmed = str.trim();
	if (!(trimmed.startsWith('{') && trimmed.endsWith('}') || trimmed.startsWith('[') && trimmed.endsWith(']'))) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return inspect(parsed, { colors: true, depth: 4, compact: true });
	} catch {
		return null;
	}
}

function highlightString(str: string): string {
	const jsonColored = tryColorizeJson(str);
	if (jsonColored !== null) {
		return jsonColored;
	}
	return str.replace(HIGHLIGHT_RE, (
		match,
		wikiLink?: string,
		template?: string,
		isoTs?: string,
		arrow?: string,
		site?: string,
		idPair?: string,
		count?: string,
	) => {
		if (wikiLink) {
			return paint(['bold', 'magentaBright'], wikiLink);
		}
		if (template) {
			return paint('cyan', template);
		}
		if (isoTs) {
			return paint('cyan', isoTs);
		}
		if (arrow) {
			return paint(['bold', 'yellowBright'], arrow);
		}
		if (site) {
			return paint(['bold', 'blueBright'], site);
		}
		if (idPair) {
			return paint('blueBright', idPair);
		}
		if (count) {
			return paint(['bold', 'yellowBright'], count);
		}
		return match;
	});
}

function formatArgs(args: unknown[], defaultColor?: 'yellow' | 'red' | 'green' | 'dim'): string[] {
	return args.map((arg) => {
		if (typeof arg !== 'string') {
			return inspect(arg, { colors: true, depth: 4, compact: true });
		}
		if (hasAnsi(arg)) {
			return arg;
		}
		const jsonColored = tryColorizeJson(arg);
		if (jsonColored !== null) {
			return jsonColored;
		}
		if (defaultColor) {
			return paint(defaultColor, arg);
		}
		return highlightString(arg);
	});
}

function formatLogLine(args: unknown[]): { prefix: string; rest: string[] } {
	const first = args[0];
	if (typeof first === 'string') {
		const startMatch = /^Start time:\s*(.+)$/i.exec(first);
		if (startMatch) {
			return {
				prefix: `${timestamp()} ${paint(['bold', 'bgMagenta', 'white'], ' START ')} ${paint('cyan', startMatch[1])}`,
				rest: formatArgs(args.slice(1)),
			};
		}
		const endMatch = /^End time:\s*(.+)$/i.exec(first);
		if (endMatch) {
			return {
				prefix: `${timestamp()} ${paint(['bold', 'bgGreen', 'black'], ' DONE ')} ${paint('cyan', endMatch[1])}`,
				rest: formatArgs(args.slice(1)),
			};
		}
		if (/^\s*✓|^SUCCESS!|^登录成功|^Successful\b/.test(first)) {
			return {
				prefix: `${timestamp()} ${paint(['bold', 'greenBright'], '[OK]')}`,
				rest: formatArgs(args, 'green'),
			};
		}
		if (/^\s*✗|^Failed\b|^Error:/.test(first)) {
			return {
				prefix: `${timestamp()} ${paint(['bold', 'redBright'], '[ERROR]')}`,
				rest: formatArgs(args, 'red'),
			};
		}
		if (/^(?:No change|No |Don't need to |跳过)|is empty\.|没有需要/.test(first)) {
			return {
				prefix: `${timestamp()} ${paint('gray', '[SKIP]')}`,
				rest: formatArgs(args, 'dim'),
			};
		}
	}
	return {
		prefix: `${timestamp()} ${paint(['bold', 'cyan'], '[INFO]')}`,
		rest: formatArgs(args),
	};
}

function installColorConsole(): void {
	const g = globalThis as GlobalWithColorFlag;
	if (g[INSTALLED_KEY]) {
		return;
	}
	g[INSTALLED_KEY] = true;

	process.env.FORCE_COLOR ??= '1';

	const origLog = console.log.bind(console);
	const origInfo = console.info.bind(console);
	const origWarn = console.warn.bind(console);
	const origError = console.error.bind(console);
	const origGroup = console.group.bind(console);
	const origGroupCollapsed = console.groupCollapsed.bind(console);
	const origGroupEnd = console.groupEnd.bind(console);

	console.log = (...args: unknown[]): void => {
		if (hasAnsi(args[0]) || typeof args[0] === 'string' && args[0].startsWith('::')) {
			origLog(...args);
			return;
		}
		const { prefix, rest } = formatLogLine(args);
		origLog(prefix, ...rest);
	};

	console.info = (...args: unknown[]): void => {
		if (hasAnsi(args[0]) || typeof args[0] === 'string' && args[0].startsWith('::')) {
			origInfo(...args);
			return;
		}
		const { prefix, rest } = formatLogLine(args);
		origInfo(prefix, ...rest);
	};

	console.warn = (...args: unknown[]): void => {
		if (hasAnsi(args[0])) {
			origWarn(...args);
			return;
		}
		origWarn(`${timestamp()} ${paint(['bold', 'yellowBright'], '[WARN]')}`, ...formatArgs(args, 'yellow'));
	};

	console.error = (...args: unknown[]): void => {
		if (hasAnsi(args[0])) {
			origError(...args);
			return;
		}
		origError(`${timestamp()} ${paint(['bold', 'redBright'], '[ERROR]')}`, ...formatArgs(args, 'red'));
	};

	console.group = (...labels: unknown[]): void => {
		const label = labels.map((l) => String(l)).join(' ');
		if (process.env.GITHUB_ACTIONS === 'true') {
			origLog(`::group::${paint(['bold', 'blueBright'], label)}`);
			return;
		}
		origGroup(paint(['bold', 'blueBright'], label));
	};

	console.groupCollapsed = (...labels: unknown[]): void => {
		const label = labels.map((l) => String(l)).join(' ');
		if (process.env.GITHUB_ACTIONS === 'true') {
			origLog(`::group::${paint(['bold', 'blueBright'], label)}`);
			return;
		}
		origGroupCollapsed(paint(['bold', 'blueBright'], label));
	};

	console.groupEnd = (): void => {
		if (process.env.GITHUB_ACTIONS === 'true') {
			origLog('::endgroup::');
			return;
		}
		origGroupEnd();
	};
}

installColorConsole();
