/**
 * Small, dependency-free Levenshtein distance.
 *
 * Replaces the reference repo's `fastest-levenshtein` package so this project
 * stays zero-runtime-dependency. Uses the standard two-row dynamic-programming
 * algorithm (O(m*n) time, O(min(m,n)) space), which is more than fast enough
 * for diff similarity scoring over modest line chunks.
 */

/** Returns the edit distance between two strings. */
export function levenshteinDistance(a: string, b: string): number {
	if (a === b) {
		return 0
	}
	if (a.length === 0) {
		return b.length
	}
	if (b.length === 0) {
		return a.length
	}

	// Ensure `b` is the shorter string so the row is the smaller dimension.
	if (b.length > a.length) {
		;[a, b] = [b, a]
	}

	let previousRow = new Array<number>(b.length + 1)
	let currentRow = new Array<number>(b.length + 1)

	for (let j = 0; j <= b.length; j++) {
		previousRow[j] = j
	}

	for (let i = 1; i <= a.length; i++) {
		currentRow[0] = i
		for (let j = 1; j <= b.length; j++) {
			const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
			currentRow[j] = Math.min(
				previousRow[j] + 1, // deletion
				currentRow[j - 1] + 1, // insertion
				previousRow[j - 1] + cost, // substitution
			)
		}
		;[previousRow, currentRow] = [currentRow, previousRow]
	}

	return previousRow[b.length]
}
