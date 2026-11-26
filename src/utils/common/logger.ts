import process from 'process';
import { inspect, styleText } from 'util';

type StyleFormat = Parameters<typeof styleText>[0];

/**
 * Apply ANSI styling regardless of TTY detection (respects `NO_COLOR`).
 */
function paint(format: StyleFormat, text: unknown): string {
	const str = String(text);
	if (process.env.NO_COLOR !== undefined) {
		return str;
	}
	return styleText(format, str, { validateStream: false });
}

function timestamp(): string {
	return paint('gray', `[${new Date().toISOString().slice(11, 19)}]`);
}

function formatExtra(args: unknown[]): string[] {
	return args.map((arg) => typeof arg === 'string'
		? arg
		: inspect(arg, { colors: true, depth: 4, compact: true }));
}

const c = {
	red: (text: unknown): string => paint('red', text),
	green: (text: unknown): string => paint('green', text),
	yellow: (text: unknown): string => paint('yellow', text),
	blue: (text: unknown): string => paint('blue', text),
	magenta: (text: unknown): string => paint('magenta', text),
	cyan: (text: unknown): string => paint('cyan', text),
	gray: (text: unknown): string => paint('gray', text),
	white: (text: unknown): string => paint('white', text),
	redBright: (text: unknown): string => paint('redBright', text),
	greenBright: (text: unknown): string => paint('greenBright', text),
	yellowBright: (text: unknown): string => paint('yellowBright', text),
	blueBright: (text: unknown): string => paint('blueBright', text),
	magentaBright: (text: unknown): string => paint('magentaBright', text),
	cyanBright: (text: unknown): string => paint('cyanBright', text),
	bold: (text: unknown): string => paint('bold', text),
	dim: (text: unknown): string => paint('dim', text),
	underline: (text: unknown): string => paint('underline', text),
	bgGreen: (text: unknown): string => paint(['bgGreen', 'black', 'bold'], text),
	bgYellow: (text: unknown): string => paint(['bgYellow', 'black', 'bold'], text),
	bgRed: (text: unknown): string => paint(['bgRed', 'white', 'bold'], text),
	bgBlue: (text: unknown): string => paint(['bgBlue', 'white', 'bold'], text),
	bgMagenta: (text: unknown): string => paint(['bgMagenta', 'white', 'bold'], text),
	bgCyan: (text: unknown): string => paint(['bgCyan', 'black', 'bold'], text),
	page: (title: string): string => paint(['bold', 'magentaBright'], `[[${title}]]`),
	num: (value: number | string): string => paint(['bold', 'yellowBright'], value),
	id: (value: number | string): string => paint(['bold', 'blueBright'], value),
	url: (value: string): string => paint(['underline', 'cyan'], value),
};

const logger = {
	start(label = 'Start'): void {
		console.log(`${timestamp()} ${paint(['bold', 'bgMagenta', 'white'], ' START ')} ${paint('magentaBright', label)} ${paint('cyan', new Date().toISOString())}`);
	},
	end(label = 'End'): void {
		console.log(`${timestamp()} ${paint(['bold', 'bgGreen', 'black'], ' DONE ')} ${paint('greenBright', label)} ${paint('cyan', new Date().toISOString())}`);
	},
	info(msg: string, ...args: unknown[]): void {
		console.log(`${timestamp()} ${paint(['bold', 'cyan'], '[INFO]')} ${msg}`, ...formatExtra(args));
	},
	success(msg: string, ...args: unknown[]): void {
		console.log(`${timestamp()} ${paint(['bold', 'greenBright'], '[OK]')} ${paint('green', msg)}`, ...formatExtra(args));
	},
	warn(msg: string, ...args: unknown[]): void {
		console.warn(`${timestamp()} ${paint(['bold', 'yellowBright'], '[WARN]')} ${paint('yellow', msg)}`, ...formatExtra(args));
	},
	error(msg: string, ...args: unknown[]): void {
		console.error(`${timestamp()} ${paint(['bold', 'redBright'], '[ERROR]')} ${paint('red', msg)}`, ...formatExtra(args));
	},
	step(msg: string, ...args: unknown[]): void {
		console.log(`${timestamp()} ${paint(['bold', 'blueBright'], '[STEP]')} ${paint('cyanBright', msg)}`, ...formatExtra(args));
	},
	debug(msg: string, ...args: unknown[]): void {
		console.log(`${timestamp()} ${paint('gray', '[DEBUG]')} ${paint('dim', msg)}`, ...formatExtra(args));
	},
	group(title: string): void {
		if (process.env.GITHUB_ACTIONS === 'true') {
			console.log(`::group::${paint(['bold', 'blueBright'], title)}`);
			return;
		}
		console.groupCollapsed(paint(['bold', 'blueBright'], title));
	},
	groupEnd(): void {
		if (process.env.GITHUB_ACTIONS === 'true') {
			console.log('::endgroup::');
			return;
		}
		console.groupEnd();
	},
};

export {
	c,
	logger,
	paint,
	timestamp,
};

export default logger;
