/**
 * TODO-list support for the agent.
 *
 * Ported from the reference repo's core/tools/UpdateTodoListTool.ts (the parser,
 * validators, and helpers) and core/environment/reminder.ts (the per-turn
 * reminder block). Roo-only dependencies (Task, formatResponse, clone-deep,
 * @roo-code/types, getLatestTodo) are removed: this module is pure and
 * dependency-free so it is unit-testable with plain Node. The actual todo-list
 * store lives in the session (extension.ts) and is exposed to tools via
 * ToolContext.
 */

import * as crypto from "crypto"

export type TodoStatus = "pending" | "in_progress" | "completed"

export interface TodoItem {
	id: string
	content: string
	status: TodoStatus
}

const VALID_STATUSES: TodoStatus[] = ["pending", "in_progress", "completed"]

/** Parse a markdown checklist into TodoItem[]. Tolerates an optional leading "- ". */
export function parseMarkdownChecklist(md: string): TodoItem[] {
	if (typeof md !== "string") return []
	const lines = md
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
	const todos: TodoItem[] = []
	for (const line of lines) {
		const match = line.match(/^(?:-\s*)?\[\s*([ xX\-~])\s*\]\s+(.+)$/)
		if (!match) continue
		let status: TodoStatus = "pending"
		if (match[1] === "x" || match[1] === "X") status = "completed"
		else if (match[1] === "-" || match[1] === "~") status = "in_progress"
		const id = crypto
			.createHash("md5")
			.update(match[2] + status)
			.digest("hex")
		todos.push({
			id,
			content: match[2],
			status,
		})
	}
	return todos
}

/** Coerce an arbitrary status string into a valid TodoStatus. */
export function normalizeStatus(status: string | undefined): TodoStatus {
	if (status === "completed") return "completed"
	if (status === "in_progress") return "in_progress"
	return "pending"
}

/** Validate the shape of a parsed todo array. */
export function validateTodos(todos: unknown[]): { valid: boolean; error?: string } {
	if (!Array.isArray(todos)) return { valid: false, error: "todos must be an array" }
	for (const [i, t] of todos.entries()) {
		if (!t || typeof t !== "object") return { valid: false, error: `Item ${i + 1} is not an object` }
		const item = t as Record<string, unknown>
		if (!item.id || typeof item.id !== "string") return { valid: false, error: `Item ${i + 1} is missing id` }
		if (!item.content || typeof item.content !== "string")
			return { valid: false, error: `Item ${i + 1} is missing content` }
		if (item.status && !VALID_STATUSES.includes(item.status as TodoStatus))
			return { valid: false, error: `Item ${i + 1} has invalid status` }
	}
	return { valid: true }
}

/** Render a TodoItem[] back to a markdown checklist. */
export function todoListToMarkdown(todos: TodoItem[]): string {
	return todos
		.map((t) => {
			let box = "[ ]"
			if (t.status === "completed") box = "[x]"
			else if (t.status === "in_progress") box = "[-]"
			return `${box} ${t.content}`
		})
		.join("\n")
}

/**
 * Format the reminders section rendered back to the model each turn.
 * Ported from core/environment/reminder.ts.
 */
export function formatReminderSection(todoList?: TodoItem[]): string {
	if (!todoList || todoList.length === 0) {
		return "You have not created a todo list yet. Create one with `update_todo_list` if your task is complicated or involves multiple steps."
	}
	const statusMap: Record<TodoStatus, string> = {
		pending: "Pending",
		in_progress: "In Progress",
		completed: "Completed",
	}
	const lines: string[] = ["====", "", "REMINDERS", "", "Below is your current list of reminders for this task. Keep them updated as you progress.", ""]

	lines.push("| # | Content | Status |")
	lines.push("|---|---------|--------|")
	todoList.forEach((item, idx) => {
		const escapedContent = item.content.replace(/\\/g, "\\\\").replace(/\|/g, "\\|")
		lines.push(`| ${idx + 1} | ${escapedContent} | ${statusMap[item.status] || item.status} |`)
	})
	lines.push("")

	lines.push(
		"",
		"IMPORTANT: When task status changes, remember to call the `update_todo_list` tool to update your progress.",
		"",
	)
	return lines.join("\n")
}

/**
 * Enforce the allowed status transitions for a single todo item.
 * Returns the updated list (immutably) and whether the transition was allowed.
 */
export function updateTodoStatus(todos: TodoItem[], id: string, nextStatus: TodoStatus): { todos: TodoItem[]; changed: boolean } {
	const idx = todos.findIndex((t) => t.id === id)
	if (idx === -1) return { todos, changed: false }
	const current = todos[idx]
	if (
		(current.status === "pending" && nextStatus === "in_progress") ||
		(current.status === "in_progress" && nextStatus === "completed") ||
		current.status === nextStatus
	) {
		const next = todos.slice()
		next[idx] = { ...current, status: nextStatus }
		return { todos: next, changed: true }
	}
	return { todos, changed: false }
}
