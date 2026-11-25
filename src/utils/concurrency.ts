/**
 * Run async mapper over items with a bounded concurrency pool.
 */
async function mapLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const safeLimit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
	const results = new Array<R>(items.length);
	let cursor = 0;
	const worker = async (): Promise<void> => {
		while (cursor < items.length) {
			const index = cursor++;
			results[index] = await fn(items[index], index);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(safeLimit, items.length)) }, worker));
	return results;
}

export default mapLimit;
