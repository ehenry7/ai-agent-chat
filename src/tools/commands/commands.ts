/**
 * Slash-command registry.
 *
 * Ported from the reference repo's services/command/commands.ts. Adaptations:
 *   - `gray-matter`                 -> local ./frontmatter#parseFrontmatter
 *   - getGlobalRooDirectory /       -> ~/.ai-agent-chat/commands (global) and
 *     getProjectRooDirectoryForCwd     <workspace>/.ai-agent-chat/commands (project)
 *   - entry.parentPath              -> path.resolve(dirPath, entry.name) (the
 *     parent is always the directory being scanned in this walk), avoiding a
 *     Node-version-dependent Dirent property.
 *
 * Priority order: project > global > built-in. Command files are markdown with
 * optional YAML frontmatter (description, argument-hint, mode). Symlinks are
 * followed up to MAX_DEPTH to support shared command libraries.
 */

import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import type { Dirent } from "fs"

import { parseFrontmatter } from "./frontmatter"
import { getBuiltInCommands, getBuiltInCommand } from "./built-in-commands"

/** Maximum depth for resolving symlinks to prevent cyclic symlink loops. */
const MAX_DEPTH = 5

export interface Command {
	name: string
	content: string
	source: "global" | "project" | "built-in"
	filePath: string
	description?: string
	argumentHint?: string
	mode?: string
}

/** Information about a resolved command file. */
interface CommandFileInfo {
	/** Original path (symlink path if symlinked, otherwise the file path). */
	originalPath: string
	/** Resolved path (target of symlink if symlinked, otherwise the file path). */
	resolvedPath: string
}

function getGlobalCommandsDir(): string {
	return path.join(os.homedir(), ".ai-agent-chat", "commands")
}

function getProjectCommandsDir(cwd: string): string {
	return path.join(cwd, ".ai-agent-chat", "commands")
}

function trimOrUndef(v: string | undefined): string | undefined {
	const t = v?.trim()
	return t ? t : undefined
}

/** Parse a command file's raw text into a Command object using frontmatter. */
function parseCommandContent(
	content: string,
	name: string,
	source: "global" | "project",
	filePath: string,
): Command {
	const parsed = parseFrontmatter(content)
	return {
		name,
		content: parsed.content.trim(),
		source,
		filePath,
		description: trimOrUndef(parsed.data.description),
		argumentHint: trimOrUndef(parsed.data["argument-hint"]),
		mode: trimOrUndef(parsed.data.mode),
	}
}

/** Recursively resolve a symbolic link and collect command file info. */
async function resolveCommandSymLink(symlinkPath: string, fileInfo: CommandFileInfo[], depth: number): Promise<void> {
	// Avoid cyclic symlinks.
	if (depth > MAX_DEPTH) {
		return
	}
	try {
		const linkTarget = await fs.readlink(symlinkPath)
		const resolvedTarget = path.resolve(path.dirname(symlinkPath), linkTarget)

		const stats = await fs.lstat(resolvedTarget)
		if (stats.isFile()) {
			if (isMarkdownFile(resolvedTarget)) {
				fileInfo.push({ originalPath: symlinkPath, resolvedPath: resolvedTarget })
			}
		} else if (stats.isDirectory()) {
			const entries = await fs.readdir(resolvedTarget, { withFileTypes: true })
			await Promise.all(entries.map((entry: Dirent) => resolveCommandDirectoryEntry(entry, resolvedTarget, fileInfo, depth + 1)))
		} else if (stats.isSymbolicLink()) {
			await resolveCommandSymLink(resolvedTarget, fileInfo, depth + 1)
		}
	} catch {
		// Skip invalid symlinks.
	}
}

/** Recursively resolve directory entries and collect command file paths. */
async function resolveCommandDirectoryEntry(
	entry: Dirent,
	dirPath: string,
	fileInfo: CommandFileInfo[],
	depth: number,
): Promise<void> {
	if (depth > MAX_DEPTH) {
		return
	}

	const fullPath = path.resolve(dirPath, entry.name)
	if (entry.isFile()) {
		if (isMarkdownFile(entry.name)) {
			fileInfo.push({ originalPath: fullPath, resolvedPath: fullPath })
		}
	} else if (entry.isSymbolicLink()) {
		await resolveCommandSymLink(fullPath, fileInfo, depth + 1)
	}
}

/** Try to resolve a symlinked command file to its real target. */
async function tryResolveSymlinkedCommand(filePath: string): Promise<string | undefined> {
	try {
		const lstat = await fs.lstat(filePath)
		if (lstat.isSymbolicLink()) {
			const linkTarget = await fs.readlink(filePath)
			const resolvedTarget = path.resolve(path.dirname(filePath), linkTarget)
			const stats = await fs.stat(resolvedTarget)
			if (stats.isFile()) {
				return resolvedTarget
			}
		}
	} catch {
		// Not a symlink or invalid symlink.
	}
	return undefined
}

/**
 * Get all available commands from built-in, global, and project directories.
 * Priority order: project > global > built-in (later sources override earlier ones).
 */
export async function getCommands(cwd: string): Promise<Command[]> {
	const commands = new Map<string, Command>()

	// Add built-in commands first (lowest priority).
	const builtInCommands = await getBuiltInCommands()
	for (const command of builtInCommands) {
		commands.set(command.name, command)
	}

	// Scan global commands (override built-in).
	await scanCommandDirectory(getGlobalCommandsDir(), "global", commands)

	// Scan project commands (highest priority - override both global and built-in).
	await scanCommandDirectory(getProjectCommandsDir(cwd), "project", commands)

	return Array.from(commands.values())
}

/**
 * Get a specific command by name (optimized to avoid scanning all commands).
 * Priority order: project > global > built-in.
 */
export async function getCommand(cwd: string, name: string): Promise<Command | undefined> {
	const projectCommand = await tryLoadCommand(getProjectCommandsDir(cwd), name, "project")
	if (projectCommand) {
		return projectCommand
	}

	const globalCommand = await tryLoadCommand(getGlobalCommandsDir(), name, "global")
	if (globalCommand) {
		return globalCommand
	}

	return await getBuiltInCommand(name)
}

/** Try to load a specific command from a directory (supports symlinks). */
async function tryLoadCommand(
	dirPath: string,
	name: string,
	source: "global" | "project",
): Promise<Command | undefined> {
	try {
		const stats = await fs.stat(dirPath)
		if (!stats.isDirectory()) {
			return undefined
		}

		const filePath = path.join(dirPath, `${name}.md`)
		let resolvedPath = filePath
		let content: string | undefined

		try {
			content = await fs.readFile(filePath, "utf-8")
		} catch {
			// File doesn't exist or can't be read - try resolving as symlink.
			const symlinkedPath = await tryResolveSymlinkedCommand(filePath)
			if (symlinkedPath) {
				try {
					content = await fs.readFile(symlinkedPath, "utf-8")
					resolvedPath = symlinkedPath
				} catch {
					return undefined
				}
			} else {
				return undefined
			}
		}

		if (content === undefined) {
			return undefined
		}

		return parseCommandContent(content, name, source, resolvedPath)
	} catch {
		return undefined
	}
}

/** Get command names for autocomplete / "not found" errors. */
export async function getCommandNames(cwd: string): Promise<string[]> {
	const commands = await getCommands(cwd)
	return commands.map((cmd) => cmd.name)
}

/** Scan a specific command directory (supports symlinks). */
async function scanCommandDirectory(
	dirPath: string,
	source: "global" | "project",
	commands: Map<string, Command>,
): Promise<void> {
	try {
		const stats = await fs.stat(dirPath)
		if (!stats.isDirectory()) {
			return
		}

		const entries = await fs.readdir(dirPath, { withFileTypes: true })

		const fileInfo: CommandFileInfo[] = []
		await Promise.all(entries.map((entry: Dirent) => resolveCommandDirectoryEntry(entry, dirPath, fileInfo, 0)))

		for (const { originalPath, resolvedPath } of fileInfo) {
			const commandName = getCommandNameFromFile(path.basename(originalPath))
			try {
				const content = await fs.readFile(resolvedPath, "utf-8")
				// Project commands override global/built-in; global only fills gaps.
				if (source === "project" || !commands.has(commandName)) {
					commands.set(commandName, parseCommandContent(content, commandName, source, resolvedPath))
				}
			} catch (error) {
				console.warn(`Failed to read command file ${resolvedPath}:`, error)
			}
		}
	} catch {
		// Directory doesn't exist or can't be read - this is fine.
	}
}

/** Extract command name from filename (strip .md extension only). */
export function getCommandNameFromFile(filename: string): string {
	if (filename.toLowerCase().endsWith(".md")) {
		return filename.slice(0, -3)
	}
	return filename
}

/** Check if a file is a markdown file. */
export function isMarkdownFile(filename: string): boolean {
	return filename.toLowerCase().endsWith(".md")
}
