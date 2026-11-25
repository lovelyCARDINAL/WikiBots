import { readFile } from 'fs/promises';
import path from 'path';

function readData(name: string): Promise<string> {
	const filePath = path.join(import.meta.dirname, '../../data', name);
	return readFile(filePath, 'utf8');
}

export default readData;
