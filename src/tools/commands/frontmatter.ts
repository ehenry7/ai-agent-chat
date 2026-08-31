/**
 * Minimal YAML-frontmatter parser (replacement for `gray-matter`).
 *
 * Only supports the flat `key: value` form used by slash-command files
 * (description, argument-hint, mode). Values may be single- or double-quoted;
 * surrounding quotes are stripped. This keeps the project zero-runtime-
 * dependency while covering everything the command registry needs.
 */

export interface ParsedFrontmatter {
	/** Parsed top-level key/value pairs (all values as strings). */
	data: Record<string, string>
	/** The document body (everything after the closing `---`). */
	content: string
}

/**
 * Parse `---\n<yaml>\n---\n<body>` into { data, content }.
 * If the document has no frontmatter, returns the whole text as `content`.
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
	if (typeof text !== "string" || text.length === 0) {
		return { data: {}, content: "" }
	}

	// Frontmatter must start at the very first character.
	if (text[0] !== "-" || text[1] !== "-" || text[2] !== "-") {
		return { data: {}, content: text }
	}

	// Find the end of the first line (the opening ---).
	const firstNewline = text.indexOf("\n")
	if (firstNewline === -1) {
		return { data: {}, content: text }
	}

	// Search for a closing line that is exactly "---" (optionally with a
	// trailing newline). Start scanning after the opening line.
	let searchFrom = firstNewline + 1
	let closingIndex = -1
	while (searchFrom < text.length) {
		const nextNewline = text.indexOf("\n", searchFrom)
		const lineEnd = nextNewline === -1 ? text.length : nextNewline
		const line = text.slice(searchFrom, lineEnd).trim()
		if (line === "---" || line === "...") {
			closingIndex = lineEnd
			break
		}
		if (nextNewline === -1) break
		searchFrom = nextNewline + 1
	}

	if (closingIndex === -1) {
		// No closing fence: treat the whole thing as content.
		return { data: {}, content: text }
	}

	const yamlBlock = text.slice(firstNewline + 1, closingIndex)
	const bodyStart = closingIndex + 1 // skip the trailing newline of the fence
	const body = text.slice(bodyStart)

	const data: Record<string, string> = {}
	for (const rawLine of yamlBlock.split("\n")) {
		const line = rawLine.trim()
		if (!line || line.startsWith("#")) continue
		const colon = line.indexOf(":")
		if (colon === -1) continue
		const key = line.slice(0, colon).trim()
		let value = line.slice(colon + 1).trim()
		// Strip a single layer of matching surrounding quotes.
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1)
		}
		if (key) {
			data[key] = value
		}
	}

	return { data, content: body }
}
