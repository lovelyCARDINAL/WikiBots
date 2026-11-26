import process from 'process';
import { inspect } from 'util';
import { paint, timestamp } from '../common/logger.ts';

const INSTALLED_KEY = Symbol.for('wikibots.colorConsole');

type GlobalWithColorFlag = typeof globalThis & { [INSTALLED_KEY]?: boolean };

function hasAnsi(val: unknown): boolean {
	return typeof val === 'string' && val.includes('\u001B[');
}

function highlightString(str: string): string {
	if (/^Start time:/i.test(str)) {
		return paint(['bold', 'magentaBright'], str);
	}
	if (/^End time:/i.test(str)) {
		return paint(['bold', 'greenBright'], str);
	}
	if (/^(?:SUCCESS!|登录成功)/.test(str)) {
		return paint(['bold', 'greenBright'], str);
	}
	return str
		.replace(/\[\[[^[\]]+\]\]/g, (m) => paint(['bold', 'magentaBright'], m))
		.replace(/\{\{[^{}]+\}\}/g, (m) => paint('cyan', m))
		.replace(/"result"\s*:\s*"Success"/g, (m) => paint(['bold', 'greenBright'], m))
		.replace(/"error"\s*:/g, (m) => paint(['bold', 'redBright'], m));
}

function formatArgs(args: unknown[], defaultColor?: 'yellow' | 'red'): string[] {
	return args.map((arg) => {
		if (typeof arg !== 'string') {
			return inspect(arg, { colors: true, depth: 4, compact: true });
		}
		if (hasAnsi(arg)) {
			return arg;
		}
		if (defaultColor) {
			return paint(defaultColor, arg);
		}
		return highlightString(arg);
	});
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
		origLog(`${timestamp()} ${paint(['bold', 'cyan'], '[INFO]')}`, ...formatArgs(args));
	};

	console.info = (...args: unknown[]): void => {
		if (hasAnsi(args[0]) || typeof args[0] === 'string' && args[0].startsWith('::')) {
			origInfo(...args);
			return;
		}
		origInfo(`${timestamp()} ${paint(['bold', 'cyan'], '[INFO]')}`, ...formatArgs(args));
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
