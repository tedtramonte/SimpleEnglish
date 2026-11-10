// OMP extension. Reproduces this plugin's Claude Code and Codex shell hooks,
// which the OMP runtime does not run. The mapping:
//
//   SessionStart  ->  before_agent_start: append the rule block to the
//                     system prompt of every provider request.
//   PostToolUse   ->  tool_result: lint the Markdown file a Write or Edit
//                     tool call just made, and report the hits before the
//                     next model step.
//   Stop          ->  session_stop: check the reply register; when it
//                     breaks the rules, ask for one advisory continuation.
//
// The linting is delegated to ../hooks/lint_hook.py by feeding it the same
// Claude-shaped JSON events the Claude Code hooks receive, so one codebase
// holds the rules for every harness. Advisory only: a lint failure, a
// missing python3, or a hung linter never blocks or loops the session.
//
// The module is ESM (.mjs) because the OMP extension loader imports it as
// ESM and requires a default-exported factory; a CommonJS module.exports
// is rejected with "Extension does not export a valid factory function".
// The src/hooks files stay CommonJS: they run as node and python3
// subprocesses, not through the loader.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildContext, promptCandidates, readFirstFile } from "../hooks/simple-english-activate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const HOOKS_DIR = path.join(__dirname, "..", "hooks");
const MARKER = "SIMPLE ENGLISH SKILL ACTIVE AUTOMATICALLY";
const LINT_TOOLS = { write: true, edit: true };
// Agent-internal Markdown the writing rules do not govern: the config and
// plugin state directories of the harnesses this plugin supports.
const INTERNAL_DIRS = {
	".claude": true,
	".codex": true,
	".omp": true,
	".agents": true,
	".cursor": true,
	".windsurf": true,
};
const HOOK_TIMEOUT_MS = 8000;
// The linter is a regex pass; cap the input so a runaway reply cannot
// make the stop hook slow.
const MAX_REPLY_CHARS = 20000;

function lintHookPath() {
	// The env override exists for tests.
	return process.env.SIMPLE_ENGLISH_LINT_HOOK || path.join(HOOKS_DIR, "lint_hook.py");
}

function ruleContext() {
	// The prompt page sits at <root>/prompts/system-prompt.md next to this
	// file; buildContext returns the fenced rule block, or the fallback
	// block when the page is missing or over the hook cap.
	return buildContext(readFirstFile(promptCandidates(ROOT, HOOKS_DIR)));
}

function isInternalMarkdown(absPath) {
	const parts = absPath.split(path.sep);
	return parts.some((part) => INTERNAL_DIRS[part] === true);
}

function runHook(event, cwd) {
	const { promise, resolve } = Promise.withResolvers();
	let child;
	try {
		child = spawn("python3", [lintHookPath()], { cwd, stdio: ["pipe", "pipe", "pipe"] });
	} catch {
		resolve(null);
		return promise;
	}
	let settled = false;
	const finish = (value) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		resolve(value);
	};
	const timer = setTimeout(() => {
		try {
			child.kill("SIGKILL");
		} catch {
			// The process is already gone.
		}
		finish(null);
	}, HOOK_TIMEOUT_MS);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	child.on("error", () => finish(null));
	child.on("close", (code) => finish({ code, stdout, stderr }));
	try {
		child.stdin.write(JSON.stringify(event));
		child.stdin.end();
	} catch {
		finish(null);
	}
	return promise;
}

async function lintWrittenFile(event, ctx) {
	const input = event.input || {};
	const candidates = [];
	if (typeof input.path === "string") candidates.push(input.path);
	if (Array.isArray(input.paths)) {
		for (const p of input.paths) {
			if (typeof p === "string") candidates.push(p);
		}
	}
	for (const rel of candidates) {
		if (!rel.toLowerCase().endsWith(".md")) continue;
		const cwd = (ctx && ctx.cwd) || process.cwd();
		const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
		if (isInternalMarkdown(abs)) continue;
		const result = await runHook(
			{
				hook_event_name: "PostToolUse",
				tool_name: event.toolName,
				tool_input: { file_path: abs },
				cwd,
			},
			cwd
		);
		// Exit code 2 plus the report prefix is the hook's advisory signal.
		// Any other outcome (clean file, python crash, timeout) stays silent.
		if (!result || result.code !== 2) continue;
		const report = result.stderr.trim();
		if (report.startsWith("simple-english:")) return report;
	}
	return null;
}

function lastAssistantText(messages) {
	// Print mode leaves last_assistant_message unset; the stop event carries
	// the transcript snapshot in `messages` instead.
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const entry = messages[i];
		const msg = (entry && entry.message) || entry;
		if (!msg || msg.role !== "assistant") continue;
		const blocks = Array.isArray(msg.content) ? msg.content : [];
		const text = blocks
			.filter((b) => b && b.type === "text" && typeof b.text === "string")
			.map((b) => b.text)
			.join("\n");
		if (text.trim()) return text;
	}
	return "";
}

async function replyNote(reply, cwd) {
	const result = await runHook(
		{
			hook_event_name: "Stop",
			last_assistant_message: reply.slice(0, MAX_REPLY_CHARS),
		},
		cwd
	);
	// The Stop hook always exits 0; a non-zero exit is a crash and stays
	// silent.
	if (!result || result.code !== 0) return null;
	try {
		const parsed = JSON.parse(result.stdout);
		return (parsed && typeof parsed.systemMessage === "string" && parsed.systemMessage) || null;
	} catch {
		return null;
	}
}

export default function simpleEnglish(pi) {
	pi.on("before_agent_start", (event) => {
		const base = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
		// The marker makes the append idempotent: a second registration of
		// this extension, or the block pasted into the system prompt by hand
		// (the README's fallback), is detected and skipped.
		if (base.includes(MARKER)) return undefined;
		// buildContext degrades to the embedded fallback block when the
		// prompt file is missing, the same way the Claude hook does.
		return { systemPrompt: (base ? base + "\n\n" : "") + ruleContext() };
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return undefined;
		if (!LINT_TOOLS[String(event.toolName).toLowerCase()]) return undefined;
		const report = await lintWrittenFile(event, ctx);
		if (!report) return undefined;
		return { additionalContext: report };
	});

	pi.on("session_stop", async (event, ctx) => {
		if (event.stop_hook_active) return undefined;
		let reply = typeof event.last_assistant_message === "string" ? event.last_assistant_message : "";
		if (!reply.trim()) reply = lastAssistantText(event.messages);
		if (!reply.trim()) return undefined;
		const cwd = (ctx && ctx.cwd) || process.cwd();
		const note = await replyNote(reply, cwd);
		if (!note) return undefined;
		return { continue: true, additionalContext: note };
	});
}

export { MARKER, INTERNAL_DIRS, isInternalMarkdown, ruleContext, runHook, lintWrittenFile, replyNote, lastAssistantText };
