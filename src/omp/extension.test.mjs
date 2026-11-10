import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, mkdirSync, writeFileSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import extension, { isInternalMarkdown } from "./extension.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function handlers() {
	const map = new Map();
	return {
		map,
		pi: { on: (name, handler) => map.set(name, handler) },
	};
}

function tmpDir(prefix) {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

// The extension resolves its helper, hook, and linter by its own file
// location, so the tests copy it into a scratch tree that mirrors the
// repository layout. The real lint_hook.py and ste_lint.py are copied too:
// the default under test is the packaged hook, and a test replaces the hook
// with a stub by calling withHook() after installExtension().
function installExtension(root) {
	const dstDir = path.join(root, "src", "omp");
	mkdirSync(dstDir, { recursive: true });
	copyFileSync(path.join(__dirname, "extension.mjs"), path.join(dstDir, "extension-under-test.mjs"));
	const hooksDst = path.join(root, "src", "hooks");
	mkdirSync(hooksDst, { recursive: true });
	copyFileSync(path.join(__dirname, "..", "hooks", "simple-english-activate.js"), path.join(hooksDst, "simple-english-activate.js"));
	copyFileSync(path.join(__dirname, "..", "hooks", "lint_hook.py"), path.join(hooksDst, "lint_hook.py"));
	cpSync(path.join(__dirname, "..", "..", "evals"), path.join(root, "evals"), { recursive: true });
	// A unique query string defeats the ESM module cache between tests.
	return import(path.join(dstDir, "extension-under-test.mjs") + `?t=${Date.now()}-${Math.random()}`);
}

function withHook(root, hookSource) {
	const hook = path.join(root, "src", "hooks", "lint_hook.py");
	mkdirSync(path.dirname(hook), { recursive: true });
	writeFileSync(hook, hookSource);
}

const VIOLATING = "The system should check the config; it was built — robustly.\n";

test("registers all three events", () => {
	const h = handlers();
	extension(h.pi);
	for (const name of ["before_agent_start", "tool_result", "session_stop"]) {
		assert.equal(h.map.has(name), true, `missing handler for ${name}`);
	}
});

test("before_agent_start appends the rule block once", () => {
	const h = handlers();
	extension(h.pi);
	const handler = h.map.get("before_agent_start");

	const first = handler({ systemPrompt: "BASE PROMPT" });
	assert.ok(first.systemPrompt.includes("BASE PROMPT"));
	assert.ok(first.systemPrompt.includes("SIMPLE ENGLISH SKILL ACTIVE AUTOMATICALLY"));

	// Idempotence: a system prompt that already carries the block is left
	// untouched, whether the block came from a previous append or from the
	// README's manual paste fallback.
	assert.equal(handler({ systemPrompt: first.systemPrompt }), undefined);
});

test("before_agent_start appends to an empty base", () => {
	const h = handlers();
	extension(h.pi);
	const handler = h.map.get("before_agent_start");
	const out = handler({});
	assert.ok(out.systemPrompt.startsWith("SIMPLE ENGLISH SKILL ACTIVE AUTOMATICALLY"));
});

test("tool_result ignores non-Markdown, other tools, and errors", async () => {
	const h = handlers();
	extension(h.pi);
	const handler = h.map.get("tool_result");
	const cwd = tmpdir();

	assert.equal(await handler({ isError: false, toolName: "write", input: { path: "notes.txt" } }, { cwd }), undefined);
	assert.equal(await handler({ isError: false, toolName: "bash", input: { path: "notes.md" } }, { cwd }), undefined);
	assert.equal(await handler({ isError: true, toolName: "write", input: { path: "notes.md" } }, { cwd }), undefined);
});

test("tool_result reports STE violations from the packaged hook", async (t) => {
	const repo = tmpDir("se-omp-");
	t.after(() => rmSync(repo, { recursive: true, force: true }));
	const { default: ext } = await installExtension(repo);
	const h = handlers();
	ext(h.pi);
	const handler = h.map.get("tool_result");
	const cwd = tmpDir("se-omp-cwd-");
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	// The hook reads the file it is pointed at, so the file must exist and
	// carry violations.
	writeFileSync(path.join(cwd, "notes.md"), VIOLATING);

	const out = await handler({ isError: false, toolName: "write", input: { path: "notes.md" } }, { cwd });
	assert.ok(out && typeof out === "object", "expected an advisory result");
	assert.ok(out.additionalContext.includes("simple-english:"));
	assert.ok(out.additionalContext.includes("banned_modal"));
});

test("tool_result skips agent-internal Markdown", async (t) => {
	const repo = tmpDir("se-omp-internal-repo-");
	t.after(() => rmSync(repo, { recursive: true, force: true }));
	const { default: ext } = await installExtension(repo);
	const h = handlers();
	ext(h.pi);
	const handler = h.map.get("tool_result");
	const cwd = tmpDir("se-omp-internal-");
	t.after(() => rmSync(cwd, { recursive: true, force: true }));

	// A file under an agent config dir must never spawn the linter, even
	// when it exists and would carry violations.
	const inner = path.join(cwd, ".claude", "memory", "notes.md");
	mkdirSync(path.dirname(inner), { recursive: true });
	writeFileSync(inner, VIOLATING);
	assert.equal(
		await handler({ isError: false, toolName: "write", input: { path: inner } }, { cwd }),
		undefined
	);
});

test("the file check inherits SIMPLE_ENGLISH_LINT_EXCLUDE from the environment", async (t) => {
	const repo = tmpDir("se-omp-excl-");
	t.after(() => rmSync(repo, { recursive: true, force: true }));
	const { default: ext } = await installExtension(repo);
	const h = handlers();
	ext(h.pi);
	const handler = h.map.get("tool_result");
	const cwd = tmpDir("se-omp-excl-cwd-");
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	writeFileSync(path.join(cwd, "notes.md"), VIOLATING);

	// Without the exclusion the same file is reported.
	const reported = await handler({ isError: false, toolName: "write", input: { path: "notes.md" } }, { cwd });
	assert.ok(reported && reported.additionalContext.includes("simple-english:"), "expected a report without the exclusion");

	// The hook process inherits the environment, so a glob matching the
	// file silences the check, exactly as under Claude Code.
	const saved = process.env.SIMPLE_ENGLISH_LINT_EXCLUDE;
	process.env.SIMPLE_ENGLISH_LINT_EXCLUDE = cwd + "/*";
	t.after(() => {
		if (saved === undefined) delete process.env.SIMPLE_ENGLISH_LINT_EXCLUDE;
		else process.env.SIMPLE_ENGLISH_LINT_EXCLUDE = saved;
	});
	assert.equal(
		await handler({ isError: false, toolName: "write", input: { path: "notes.md" } }, { cwd }),
		undefined
	);
});

test("isInternalMarkdown matches agent config dirs anywhere in the path", () => {
	assert.equal(isInternalMarkdown("/home/u/.claude/notes.md"), true);
	assert.equal(isInternalMarkdown("/home/u/proj/.omp/rules/x.md"), true);
	assert.equal(isInternalMarkdown("/home/u/proj/docs/notes.md"), false);
});

test("session_stop returns an advisory continuation for a violating reply", async (t) => {
	const repo = tmpDir("se-omp-stop-");
	t.after(() => rmSync(repo, { recursive: true, force: true }));
	const { default: ext } = await installExtension(repo);
	withHook(repo, ["import json", "print(json.dumps({'systemMessage': 'simple-english reply check: 2 em-dash(es).'}))"].join("\n"));
	const h = handlers();
	ext(h.pi);
	const handler = h.map.get("session_stop");
	const cwd = tmpDir("se-omp-stop-cwd-");
	t.after(() => rmSync(cwd, { recursive: true, force: true }));

	const result = await handler(
		{ stop_hook_active: false, last_assistant_message: "It broke — it is bad." },
		{ cwd }
	);
	assert.deepEqual(result, {
		continue: true,
		additionalContext: "simple-english reply check: 2 em-dash(es).",
	});
});

test("session_stop stays silent on a clean reply and when the hook already ran", async (t) => {
	const repo = tmpDir("se-omp-stop2-");
	t.after(() => rmSync(repo, { recursive: true, force: true }));
	const { default: ext } = await installExtension(repo);
	withHook(repo, "import sys\nsys.exit(0)\n");
	const h = handlers();
	ext(h.pi);
	const handler = h.map.get("session_stop");
	const cwd = tmpDir("se-omp-stop2-cwd-");
	t.after(() => rmSync(cwd, { recursive: true, force: true }));

	assert.equal(await handler({ stop_hook_active: false, last_assistant_message: "It is fine." }, { cwd }), undefined);
	// The stop hook already ran once for this reply (the continuation is
	// pending); a second fire must not chain.
	assert.equal(
		await handler({ stop_hook_active: true, last_assistant_message: "It broke — badly." }, { cwd }),
		undefined
	);
	assert.equal(await handler({ stop_hook_active: false, last_assistant_message: "" }, { cwd }), undefined);
});

test("session_stop falls back to the transcript in print mode", async (t) => {
	const repo = tmpDir("se-omp-stop4-");
	t.after(() => rmSync(repo, { recursive: true, force: true }));
	const { default: ext } = await installExtension(repo);
	withHook(
		repo,
		[
			"import json, sys",
			"event = json.load(sys.stdin)",
			"reply = event.get('last_assistant_message', '')",
			"if 'broke' in reply: print(json.dumps({'systemMessage': 'simple-english reply check: 1 em-dash(s).'}))",
			"sys.exit(0)",
		].join("\n")
	);
	const h = handlers();
	ext(h.pi);
	const handler = h.map.get("session_stop");
	const cwd = tmpDir("se-omp-stop4-cwd-");
	t.after(() => rmSync(cwd, { recursive: true, force: true }));

	// Print mode: last_assistant_message is null, the transcript is in
	// `messages`, and the reply text is nested under message.content.
	const event = {
		stop_hook_active: false,
		last_assistant_message: null,
		messages: [
			{ message: { role: "user", content: [{ type: "text", text: "hi" }] } },
			{ message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "It broke — it is bad." }] } },
		],
	};
	const result = await handler(event, { cwd });
	assert.deepEqual(result, {
		continue: true,
		additionalContext: "simple-english reply check: 1 em-dash(s).",
	});
});

test("session_stop reports violations from the packaged hook", async (t) => {
	const repo = tmpDir("se-omp-stop3-");
	t.after(() => rmSync(repo, { recursive: true, force: true }));
	const { default: ext } = await installExtension(repo);
	const h = handlers();
	ext(h.pi);
	const handler = h.map.get("session_stop");
	const cwd = tmpDir("se-omp-stop3-cwd-");
	t.after(() => rmSync(cwd, { recursive: true, force: true }));

	const result = await handler({ stop_hook_active: false, last_assistant_message: "It broke — it is bad." }, { cwd });
	assert.ok(result && typeof result.continue === "boolean" && typeof result.additionalContext === "string");
	assert.ok(result.additionalContext.includes("simple-english reply check"));
});

test("a hung hook is killed and the result stays silent", async (t) => {
	const repo = tmpDir("se-omp-hang-");
	t.after(() => rmSync(repo, { recursive: true, force: true }));
	const { default: ext } = await installExtension(repo);
	withHook(repo, "import time\ntime.sleep(30)\n");
	const h = handlers();
	ext(h.pi);
	const handler = h.map.get("session_stop");
	const cwd = tmpDir("se-omp-hang-cwd-");
	t.after(() => rmSync(cwd, { recursive: true, force: true }));

	const started = Date.now();
	assert.equal(
		await handler({ stop_hook_active: false, last_assistant_message: "It broke — badly." }, { cwd }),
		undefined
	);
	// The kill must happen well before the 8 s cap: the linter gets 8 s,
	// so a 30 s sleep resolves at the cap, not at sleep end.
	assert.ok(Date.now() - started < 15000, "the hung hook was not killed in time");
});

test("the packaged hook sits next to the extension in the repository", () => {
	assert.ok(existsSync(path.join(__dirname, "..", "hooks", "lint_hook.py")));
	assert.ok(existsSync(path.join(__dirname, "..", "hooks", "simple-english-activate.js")));
});
