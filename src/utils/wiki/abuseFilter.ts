import { load } from 'cheerio';
import type { MediaWikiApi } from 'wiki-saikou';

export interface AbuseFilterFormDetails {
	formSnippet: Record<string, unknown>;
	action: string;
}

/**
 * Fetch and parse the Special:AbuseFilter/<id> edit form fields and action URL.
 */
export async function getAbuseFilterDetails(api: MediaWikiApi, id: number): Promise<AbuseFilterFormDetails> {
	const { response: { data } } = await api.request.get('/index.php', {
		query: {
			title: `Special:AbuseFilter/${id}`,
		},
	});
	const $raw = load(data);
	const $form = $raw('#mw-content-text > form');
	const textInputTypes = [undefined, 'hidden'];
	const checkboxInputTypes = ['checkbox'];
	const acceptableInputTypes = [...textInputTypes, ...checkboxInputTypes];
	return {
		formSnippet: Object.fromEntries([
			...$form.find('input').toArray()
				.map(({ attribs: { name, value, type, checked } }) => [acceptableInputTypes.includes(type) ? name : false, checkboxInputTypes.includes(type) ? !!checked : value]),
			...$form.find('textarea').toArray()
				.map(({ attribs: { name }, children }) => [name, (children[0] as { data?: string } | undefined)?.data || '']),
			...$form.find('select').toArray()
				.map((ele) => [ele.attribs.name, ele.childNodes.find((n): n is typeof ele => 'attribs' in n && typeof n.attribs?.selected === 'string')])
				.map(([name, option]) => [name, typeof option === 'object' ? option?.attribs?.value : undefined]),
		].filter(([name]) => Boolean(name))) as Record<string, unknown>,
		action: $form.attr('action') || '',
	};
}
