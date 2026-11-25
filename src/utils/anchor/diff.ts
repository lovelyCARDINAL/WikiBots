interface AnchorSet {
	headings: string[];
	all: Set<string>;
}

/**
 * Compute Levenshtein edit distance between two strings.
 */
function levenshtein(a: string, b: string): number {
	if (a === b) {
		return 0;
	}
	if (!a.length) {
		return b.length;
	}
	if (!b.length) {
		return a.length;
	}
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const curr = [i];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
		}
		prev = curr;
	}
	return prev[b.length];
}

/**
 * Compute normalized similarity distance in [0, 1] (smaller = more similar).
 */
function anchorDistanceScore(from: string, to: string): number {
	const a = from.toLowerCase();
	const b = to.toLowerCase();
	const dist = levenshtein(a, b);
	const maxLen = Math.max(a.length, b.length, 1);
	const minLen = Math.min(a.length, b.length);
	if (minLen >= 2 && (a.includes(b) || b.includes(a))) {
		return Math.min(0.35, dist / (maxLen * 2));
	}
	return 2 * dist / (a.length + b.length || 1);
}

/**
 * Compare two revisions of a page and return similarity-verified section renames and removed headings.
 */
function detectSectionChanges(
	oldAnchors: AnchorSet,
	newAnchors: AnchorSet,
): { renames: Map<string, string>; removed: string[] } {
	const removedList = oldAnchors.headings.filter((h) => !newAnchors.all.has(h));
	const addedList = newAnchors.headings.filter((h) => !oldAnchors.all.has(h));
	const renames = new Map<string, string>();

	if (!removedList.length || !addedList.length) {
		return { renames, removed: removedList };
	}

	const SIMILARITY_THRESHOLD = 0.75;
	const candidates: Array<{ score: number; from: string; to: string }> = [];
	for (const from of removedList) {
		for (const to of addedList) {
			const score = anchorDistanceScore(from, to);
			if (score < SIMILARITY_THRESHOLD) {
				candidates.push({ score, from, to });
			}
		}
	}
	candidates.sort((x, y) => x.score - y.score);

	const usedFrom = new Set<string>();
	const usedTo = new Set<string>();
	for (const { from, to } of candidates) {
		if (!usedFrom.has(from) && !usedTo.has(to)) {
			usedFrom.add(from);
			usedTo.add(to);
			renames.set(from, to);
		}
	}

	return { renames, removed: removedList.filter((h) => !usedFrom.has(h)) };
}

function detectSectionRenames(oldAnchors: AnchorSet, newAnchors: AnchorSet): Map<string, string> {
	return detectSectionChanges(oldAnchors, newAnchors).renames;
}

function buildRenameMap(
	stepRenames: Array<Map<string, string>>,
	finalAnchors: Set<string>,
): Map<string, string> {
	const combined = new Map<string, string>();
	for (const step of stepRenames) {
		for (const [oldA, newA] of step) {
			for (const [k, v] of combined) {
				if (v === oldA) {
					combined.set(k, newA);
				}
			}
			if (!combined.has(oldA)) {
				combined.set(oldA, newA);
			}
		}
	}

	for (const [oldA, newA] of [...combined]) {
		if (oldA === newA || finalAnchors.has(oldA) || !finalAnchors.has(newA)) {
			combined.delete(oldA);
		}
	}
	return combined;
}

export type { AnchorSet };
export {
	detectSectionChanges,
	detectSectionRenames,
	buildRenameMap,
};
