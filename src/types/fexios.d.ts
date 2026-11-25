import 'fexios';

declare module 'fexios' {
	interface FexiosRequestOptions {
		retry?: number;
		noCache?: boolean;
	}
}
