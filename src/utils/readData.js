import { readFile } from 'fs/promises';
import path from 'path';

/**
 * @param {string} name
 * @returns {Promise<string>}
 */
function readData(name) {
	const filePath = path.join(import.meta.dirname, '../../data', name);
	return readFile(filePath, 'utf8');
}

export default readData;