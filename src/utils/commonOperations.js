function splitAndJoin(list, chunkSize) {
	const chunks = [];
	for (let i = 0; i < list.length; i += chunkSize) {
		const chunk = list.slice(i, i + chunkSize);
		const joinedChunk = chunk.join('|').replace(/ /g, '_');
		chunks.push(joinedChunk);
	}
	return chunks;
}

export default splitAndJoin;
