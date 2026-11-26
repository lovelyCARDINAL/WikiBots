import { load } from 'cheerio';
import type { MediaWikiApi } from 'wiki-saikou';
import logger from '../common/logger.ts';
import config from '../core/config.ts';

export interface AbuseFilterFormDetails {
	formSnippet: Record<string, unknown>;
	action: string;
}

const VALUE_INPUT_TYPES = new Set([undefined, 'text', 'hidden', 'number']);

/**
 * Parse the Special:AbuseFilter/<id> HTML editing form into submittable fields and action URL.
 */
export function parseAbuseFilterForm(html: string): AbuseFilterFormDetails {
	const $raw = load(html);
	const editingForm = $raw('#mw-abusefilter-editing-form');
	const $form = editingForm.length ? editingForm : $raw('#mw-content-text form').first();
	const formSnippet: Record<string, unknown> = {};

	for (const el of $form.find('input').toArray()) {
		const { name, type, value, checked } = el.attribs;
		if (!name) {
			continue;
		}
		if (type === 'checkbox' || type === 'radio') {
			if (checked !== undefined) {
				formSnippet[name] = value || '1';
			}
			continue;
		}
		if (VALUE_INPUT_TYPES.has(type)) {
			formSnippet[name] = value ?? '';
		}
	}

	for (const el of $form.find('textarea').toArray()) {
		const { name } = el.attribs;
		if (name) {
			formSnippet[name] = $raw(el).text();
		}
	}

	for (const el of $form.find('select').toArray()) {
		const { name } = el.attribs;
		if (!name) {
			continue;
		}
		const $select = $raw(el);
		const selectedVal = $select.find('option[selected]').attr('value') ?? $select.find('option').first().attr('value');
		if (selectedVal !== undefined) {
			formSnippet[name] = selectedVal;
		}
	}

	return {
		formSnippet,
		action: $form.attr('action') || '',
	};
}

/**
 * Fetch and parse the Special:AbuseFilter/<id> edit form fields and action URL.
 */
export async function getAbuseFilterDetails(api: MediaWikiApi, id: number): Promise<AbuseFilterFormDetails> {
	const { response: { data } } = await api.request.get('/index.php', {
		query: {
			title: `Special:AbuseFilter/${id}`,
		},
		headers: { 'user-agent': config.indexUseragent },
	});
	return parseAbuseFilterForm(typeof data === 'string' ? data : '');
}

/**
 * Submit an AbuseFilter edit form and verify the HTML response indicates a successful save.
 */
export async function submitAbuseFilterForm(
	api: MediaWikiApi,
	action: string,
	formSnippet: Record<string, unknown>,
	options?: { retry?: number; label?: string },
): Promise<void> {
	const label = options?.label || 'AbuseFilter';
	const { response: { status, data } } = await api.request.post(action, formSnippet, {
		...options?.retry ? { retry: options.retry } : {},
		headers: { 'user-agent': config.indexUseragent },
	});

	const $ = load(typeof data === 'string' ? data : '');
	const errorMsg = $('.cdx-message--error, .cdx-message--warning, .mw-message-box-error, .mw-message-box-warning, .errorbox, .warningbox, .error').text().trim();
	const stillEditing = $('#mw-abusefilter-editing-form').length > 0;
	const successMsg = $('.cdx-message--success, .mw-message-box-success, .successbox').text().trim();
	const pageTitle = $('title').text().trim();

	if (errorMsg || stillEditing) {
		throw new Error(`Failed to save ${label} (HTTP ${status}, title="${pageTitle}"): ${errorMsg || 'still on editing form'}`);
	}
	logger.success(`Updated ${label}${successMsg ? `: ${successMsg}` : '!'}`);
}
