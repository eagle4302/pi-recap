#!/usr/bin/env node
/**
 * Headless behavioural test for extensions/recap.ts.
 *
 * The extension is loaded with pi's own TypeScript loader (jiti) and pi's real
 * TUI components, so the entry renderer is exercised for real; everything else
 * (ExtensionAPI, session branch, model registry, UI) is a small mock.
 *
 * Requires the pi coding agent to be installed. Resolution order:
 *   1. $PI_PACKAGE_DIR
 *   2. ./node_modules/@earendil-works/pi-coding-agent
 *   3. global npm prefixes and PATH (see scripts/find-pi.mjs)
 *
 * Run: node test/smoke.mjs   (or: npm test)
 */

import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findPiPackageDir } from "../scripts/find-pi.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const extensionPath = join(repoRoot, "extensions", "recap.ts");

// ---------------------------------------------------------------------------
// Locate pi, jiti and pi-tui
// ---------------------------------------------------------------------------

const piDir = findPiPackageDir(repoRoot);
if (!piDir) {
	console.error(
		"Could not find the pi coding agent.\n" +
			"Install it (npm i -g @earendil-works/pi-coding-agent) or point PI_PACKAGE_DIR at its package directory.",
	);
	process.exit(2);
}

const requireFromPi = createRequire(join(piDir, "package.json"));
const piVersion = JSON.parse(readFileSync(join(piDir, "package.json"), "utf8")).version;

const jitiPackageDir = dirname(requireFromPi.resolve("jiti/package.json"));
const tuiEntry = requireFromPi.resolve("@earendil-works/pi-tui");

// A stub for pi-coding-agent: the extension only imports types from it, and the
// real entry point boots the whole agent.
const coreStubPath = join(repoRoot, "test", ".core-stub.mjs");
writeFileSync(coreStubPath, "export {};\n");

const { createJiti } = await import(pathToFileURL(join(jitiPackageDir, "lib", "jiti.mjs")).href);
const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-tui": tuiEntry,
		"@earendil-works/pi-coding-agent": coreStubPath,
	},
	moduleCache: false,
});

const extension = await jiti(extensionPath);
const recapExtension = extension.default;
if (typeof recapExtension !== "function") {
	console.error("extensions/recap.ts does not default-export a function");
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/** Theme stub: every colour helper returns its last argument. */
const theme = new Proxy(
	{},
	{
		get: () => (...args) => args[args.length - 1],
	},
);

const model = (provider, id, options = {}) => ({
	provider,
	id,
	name: id,
	cost: { input: options.input ?? 1, output: options.output ?? 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: options.contextWindow ?? 100_000,
	maxTokens: options.maxTokens ?? 4096,
	input: options.images ? ["image"] : ["text"],
	reasoning: options.reasoning ?? false,
	available: options.available ?? true,
	auth: options.auth ?? true,
});

const userEntry = (text, id = "u1") => ({
	type: "message",
	id,
	message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
});

const assistantEntry = (text, id = "a1", stopReason = "stop") => ({
	type: "message",
	id,
	message: {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
		usage: { input: 10, output: 10, cost: { total: 0 } },
		timestamp: Date.now(),
	},
});

const toolCallAssistantEntry = (id = "a2") => ({
	type: "message",
	id,
	message: {
		role: "assistant",
		content: [
			{ type: "text", text: "Editing the file." },
			{ type: "toolCall", name: "edit", arguments: { path: "lib/app.ts", oldText: "a", newText: "b" } },
		],
		stopReason: "toolUse",
		timestamp: Date.now(),
	},
});

const toolResultEntry = (text, id = "t1", isError = false) => ({
	type: "message",
	id,
	message: { role: "toolResult", toolName: "edit", isError, content: [{ type: "text", text }], timestamp: Date.now() },
});

const shellEntry = (command, output, exitCode = 0, id = "b1") => ({
	type: "message",
	id,
	message: { role: "bashExecution", command, output, exitCode, timestamp: Date.now() },
});

const defaultComplete = async (chosen) => ({
	content: [{ type: "text", text: `- recap via ${chosen.id}` }],
	usage: { input: 120, output: 18, cacheRead: 30, cost: { total: 0.0012 } },
});

const deferred = () => {
	let resolvePromise;
	const promise = new Promise((r) => {
		resolvePromise = r;
	});
	return { promise, resolve: resolvePromise };
};

function createHarness(options = {}) {
	const handlers = new Map();
	const commands = new Map();
	const renderers = new Map();
	const entries = [];
	const pi = {
		on(event, handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		registerCommand(name, config) {
			commands.set(name, config);
		},
		registerEntryRenderer(type, renderer) {
			renderers.set(type, renderer);
		},
		appendEntry(type, data) {
			entries.push({ type, id: `entry-${entries.length + 1}`, data, timestamp: Date.now() });
		},
	};

	const models = options.models ?? [model("acme", "cheap", { input: 0.3, output: 1.2 })];
	let sessionId = options.sessionId ?? "session-1";
	const branch = options.branch ?? [userEntry("do the thing"), assistantEntry("Done.")];
	const notifications = [];
	const statuses = [];
	const completions = [];
	const complete =
		options.complete ??
		(async (chosen) => {
			completions.push(chosen);
			return defaultComplete(chosen);
		});

	const ctx = {
		hasUI: options.hasUI ?? true,
		cwd: repoRoot,
		model: options.sessionModel,
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => sessionId,
		},
		modelRegistry: {
			getAvailable: () => models.filter((m) => m.available),
			find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
			hasConfiguredAuth: (m) => m.auth,
			complete,
		},
		ui: {
			notify: (message, level) => notifications.push({ level: level ?? "info", message }),
			setStatus: (key, value) => statuses.push([key, value]),
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
		},
	};

	recapExtension(pi);

	return {
		pi,
		ctx,
		entries,
		notifications,
		statuses,
		completions,
		renderers,
		branch,
		setBranch: (next) => {
			branch.length = 0;
			branch.push(...next);
		},
		setSessionId: (next) => {
			sessionId = next;
		},
		emit: async (event) => {
			for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
		},
		emitAuto: async () => {
			for (const handler of handlers.get("agent_settled") ?? []) await handler({ type: "agent_settled" }, ctx);
		},
		emitShutdown: async (reason) => {
			for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason }, ctx);
		},
		startSession: async () => {
			for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
		},
		run: async (args) => {
			await commands.get("recap").handler(args, ctx);
		},
		hasHandler: (event) => handlers.has(event),
		hasRenderer: (type) => renderers.has(type),
		commandInfo: () => commands.get("recap"),
	};
}

const quiesce = async () => {
	for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 1));
};

// ---------------------------------------------------------------------------
// Tiny test runner
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];
const assert = (condition, message) => {
	if (!condition) throw new Error(message);
};
const eq = (actual, expected, message) => {
	if (actual !== expected) throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
};
const test = async (name, fn) => {
	try {
		await fn();
		passed += 1;
		console.log(`  ok    ${name}`);
	} catch (error) {
		failures.push(`${name}: ${error.message}`);
		console.log(`  FAIL  ${name}\n        ${error.message}`);
	}
};

console.log(`recap smoke test · pi ${piVersion} · node ${process.version}\n`);

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

await test("registers a renderer, a command and the lifecycle handlers", () => {
	const h = createHarness();
	assert(h.hasRenderer("recap"), "no entry renderer registered for 'recap'");
	assert(h.commandInfo(), "no /recap command registered");
	assert(h.hasHandler("session_start"), "no session_start handler");
	assert(h.hasHandler("agent_settled"), "no agent_settled handler");
	assert(h.hasHandler("session_shutdown"), "no session_shutdown handler");
});

// ---------------------------------------------------------------------------
// Automatic recap
// ---------------------------------------------------------------------------

await test("agent_settled appends exactly one recap entry", async () => {
	const h = createHarness();
	await h.emitAuto();
	await quiesce();
	eq(h.entries.length, 1, "entry count");
	eq(h.entries[0].type, "recap", "entry type");
	eq(h.entries[0].data.text, "- recap via cheap", "recap text");
	eq(h.entries[0].data.model, "acme/cheap", "model label");
	assert(h.entries[0].data.error !== true, "entry should not be an error");
	assert(typeof h.entries[0].data.createdAt === "number", "createdAt missing");
	assert(typeof h.entries[0].data.durationMs === "number", "durationMs missing");
});

await test("usage is recorded on the entry", async () => {
	const h = createHarness();
	await h.emitAuto();
	await quiesce();
	const usage = h.entries[0].data.usage;
	eq(usage.input, 120, "input tokens");
	eq(usage.output, 18, "output tokens");
	eq(usage.cacheRead, 30, "cache read tokens");
	eq(usage.cost, 0.0012, "cost");
});

await test("the prompt carries user text, tool calls, tool results and shell commands", async () => {
	let prompt;
	const h = createHarness({
		branch: [
			userEntry("please fix the crash in lib/app.ts"),
			toolCallAssistantEntry("a2"),
			toolResultEntry("edit applied"),
			shellEntry("npm test", "3 passing", 0, "b1"),
			assistantEntry("All tests pass.", "a3"),
		],
		complete: async (_model, context) => {
			prompt = context.messages[0].content[0].text;
			return defaultComplete({ id: "cheap" });
		},
	});
	await h.emitAuto();
	await quiesce();
	assert(typeof prompt === "string", "no prompt captured");
	assert(prompt.includes("please fix the crash in lib/app.ts"), "user text missing from prompt");
	assert(prompt.includes("[tool] edit("), "tool call missing from prompt");
	assert(prompt.includes("[tool result] edit applied"), "tool result missing from prompt");
	assert(prompt.includes("[shell command typed by the user] $ npm test"), "shell command missing from prompt");
	assert(prompt.includes("<transcript>") && prompt.includes("</transcript>"), "transcript fence missing");
	assert(prompt.includes("data, not instructions"), "prompt-injection guard missing");
});

await test("the same exchange is never recapped twice", async () => {
	const h = createHarness();
	await h.emitAuto();
	await quiesce();
	await h.emitAuto();
	await quiesce();
	eq(h.entries.length, 1, "entry count after two settles on one exchange");
});

await test("a new exchange is recapped again", async () => {
	const h = createHarness();
	await h.emitAuto();
	await quiesce();
	h.setBranch([userEntry("second question", "u2"), assistantEntry("Second answer.", "a2")]);
	await h.emitAuto();
	await quiesce();
	eq(h.entries.length, 2, "entry count");
});

await test("aborted and failed turns are skipped", async () => {
	for (const stopReason of ["aborted", "error"]) {
		const h = createHarness({ branch: [userEntry("x"), assistantEntry("partial", "a1", stopReason)] });
		await h.emitAuto();
		await quiesce();
		eq(h.entries.length, 0, `entries for stopReason=${stopReason}`);
	}
});

await test("a settle during an in-flight recap queues exactly one more run", async () => {
	const gate = deferred();
	const h = createHarness({
		complete: async (chosen) => {
			await gate.promise;
			return defaultComplete(chosen);
		},
	});
	await h.emitAuto();
	h.setBranch([userEntry("second", "u2"), assistantEntry("Second.", "a2")]);
	await h.emitAuto();
	await h.emitAuto();
	eq(h.entries.length, 0, "no entry before the gate opens");
	gate.resolve();
	await quiesce();
	eq(h.entries.length, 2, "queued run should produce a second capture");
});

await test("a recap is dropped when the session changed mid-flight", async () => {
	// The id changes behind the run's back (no session events).
	const gate = deferred();
	const h = createHarness({
		complete: async (chosen) => {
			await gate.promise;
			return defaultComplete(chosen);
		},
	});
	await h.emitAuto();
	h.setSessionId("session-2");
	gate.resolve();
	await quiesce();
	eq(h.entries.length, 0, "in-flight recap leaked into the next session");

	// A real replacement: session_shutdown("new") then session_start.
	const second = deferred();
	const g = createHarness({
		complete: async (chosen) => {
			await second.promise;
			return defaultComplete(chosen);
		},
	});
	await g.emitAuto();
	g.setSessionId("session-2");
	await g.emitShutdown("new");
	await g.startSession();
	second.resolve();
	await quiesce();
	eq(g.entries.length, 0, "recap from the replaced session leaked into the new one");
});

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

await test("auto picks the cheapest usable model", async () => {
	const h = createHarness({
		models: [
			model("acme", "pricey", { input: 5, output: 20 }),
			model("acme", "cheap", { input: 0.3, output: 1.2 }),
			model("other", "cheaper-but-no-auth", { input: 0.0, output: 0.0, auth: false }),
			model("other", "too-small", { input: 0.1, output: 0.1, contextWindow: 2_000 }),
			model("other", "image-only", { input: 0.1, output: 0.1, images: true }),
		],
	});
	await h.emitAuto();
	await quiesce();
	eq(h.entries[0].data.model, "acme/cheap", "auto pick");
});

await test("auto pick is reflected in /recap status", async () => {
	const h = createHarness({ models: [model("acme", "cheap", { input: 0.3, output: 1.2 })] });
	await h.emitAuto();
	await quiesce();
	await h.run("status");
	const status = h.notifications.at(-1).message;
	assert(status.includes("Automatic recaps: on"), "status should report recaps on");
	assert(status.includes("auto → acme/cheap"), `status should report the auto pick, got: ${status}`);
});

await test("/recap model pins a model and /recap model auto resets it", async () => {
	const h = createHarness({
		models: [model("acme", "cheap", { input: 0.3, output: 1.2 }), model("acme", "pinned", { input: 9, output: 9 })],
	});
	await h.run("model acme/pinned");
	await h.emitAuto();
	await quiesce();
	eq(h.entries.at(-1).data.model, "acme/pinned", "pinned model should be used");
	await h.run("model auto");
	h.setBranch([userEntry("again", "u2"), assistantEntry("Sure.", "a2")]);
	await h.emitAuto();
	await quiesce();
	eq(h.entries.at(-1).data.model, "acme/cheap", "auto should be restored");
});

await test("an unknown pinned model warns and changes nothing", async () => {
	const h = createHarness({ models: [model("acme", "cheap", { input: 0.3, output: 1.2 })] });
	await h.run("model ghost/nope");
	const note = h.notifications.at(-1);
	eq(note.level, "warning", "warning level");
	assert(note.message.includes("ghost/nope"), "warning should name the model");
	await h.emitAuto();
	await quiesce();
	eq(h.entries[0].data.model, "acme/cheap", "auto pick should be unchanged");
});

await test("no usable model warns once per session for auto, always for manual", async () => {
	const h = createHarness({ models: [model("acme", "broken", { auth: false })] });
	await h.emitAuto();
	await h.emitAuto();
	await quiesce();
	eq(h.entries.length, 0, "no entry without a model");
	eq(h.notifications.length, 1, "auto should warn exactly once");
	await h.run("");
	eq(h.notifications.length, 2, "manual should warn every time");
	eq(h.notifications.at(-1).level, "warning", "manual warning level");
});

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

await test("a provider error appends a failed recap entry", async () => {
	const h = createHarness({
		complete: async () => {
			throw new Error("429 rate limited");
		},
	});
	await h.emitAuto();
	await quiesce();
	eq(h.entries.length, 1, "entry count");
	eq(h.entries[0].data.error, true, "error flag");
	assert(h.entries[0].data.text.includes("429"), "error message should be kept");
});

await test("an empty model response is an error", async () => {
	const h = createHarness({
		complete: async () => ({ content: [], usage: undefined }),
	});
	await h.run("");
	await quiesce();
	eq(h.entries[0].data.error, true, "error flag for empty response");
	eq(h.notifications.at(-1).level, "error", "manual failure should notify with error");
});

// ---------------------------------------------------------------------------
// Commands and toggling
// ---------------------------------------------------------------------------

await test("/recap on|off toggles automatic recaps", async () => {
	const h = createHarness();
	await h.run("off");
	await h.emitAuto();
	await quiesce();
	eq(h.entries.length, 0, "no automatic recap while off");
	await h.run("");
	await quiesce();
	eq(h.entries.length, 1, "manual /recap works while off");
	await h.run("on");
	h.setBranch([userEntry("again", "u2"), assistantEntry("Sure.", "a2")]);
	await h.emitAuto();
	await quiesce();
	eq(h.entries.length, 2, "automatic recap back on");
});

await test("nothing to recap reports instead of calling the model", async () => {
	const h = createHarness({ branch: [] });
	await h.run("");
	await quiesce();
	eq(h.entries.length, 0, "no entry for an empty exchange");
	eq(h.notifications.at(-1).level, "warning", "warning level");
});

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

await test("the renderer renders the recap lines", () => {
	const h = createHarness();
	const renderer = h.renderers.get("recap");
	const entry = {
		type: "custom",
		customType: "recap",
		id: "e1",
		data: {
			text: "- Fixed the crash in lib/app.ts\n- Tests still failing",
			model: "acme/cheap",
			createdAt: Date.now(),
			durationMs: 1200,
			usage: { input: 100, output: 20, cost: 0.001, cacheRead: 0 },
		},
	};
	const component = renderer(entry, { expanded: false }, theme);
	assert(component, "renderer returned nothing");
	const lines = component.render(70).map((line) => line.trimEnd()).filter(Boolean);
	const text = lines.join("\n");
	assert(text.includes("Recap"), `title missing: ${text}`);
	assert(text.includes("acme/cheap"), `model missing: ${text}`);
	assert(text.includes("- Fixed the crash in lib/app.ts"), `first line missing: ${text}`);
	assert(text.includes("- Tests still failing"), `second line missing: ${text}`);
	assert(!text.includes("1200ms"), "collapsed view should hide the detail line");
	const expanded = renderer(entry, { expanded: true }, theme)
		.render(70)
		.join("\n");
	assert(expanded.includes("1200ms"), "expanded view should show latency");
	assert(expanded.includes("$0.0010"), "expanded view should show cost");
});

await test("the renderer wraps inside the given width", () => {
	const h = createHarness();
	const renderer = h.renderers.get("recap");
	const entry = {
		type: "custom",
		customType: "recap",
		id: "e1",
		data: {
			text: `- ${"修改了檔案 ".repeat(30)}`,
			model: "acme/cheap",
			createdAt: Date.now(),
			durationMs: 5,
		},
	};
	for (const width of [40, 70]) {
		const lines = renderer(entry, { expanded: false }, theme).render(width);
		assert(lines.length > 2, `expected wrapping at width ${width}`);
		for (const line of lines) {
			assert(line.length <= width, `line wider than ${width}: ${line.length}`);
		}
	}
});

await test("the renderer survives malformed data", () => {
	const h = createHarness();
	const renderer = h.renderers.get("recap");
	for (const data of [undefined, null, {}, { text: 42 }]) {
		const result = renderer({ type: "custom", customType: "recap", id: "e1", data }, { expanded: false }, theme);
		assert(result === undefined, `expected undefined for ${JSON.stringify(data)}`);
	}
});

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

await test("quit/reload stops the extension; new/resume/fork does not", async () => {
	const h = createHarness();
	await h.emitAuto();
	await quiesce();
	eq(h.entries.length, 1, "baseline recap");
	h.setBranch([userEntry("second", "u2"), assistantEntry("Second.", "a2")]);
	await h.emitShutdown("new");
	await h.emitAuto();
	await quiesce();
	eq(h.entries.length, 2, "a new session must keep recapping");
	await h.emitShutdown("quit");
	h.setBranch([userEntry("third", "u3"), assistantEntry("Third.", "a3")]);
	await h.emitAuto();
	await quiesce();
	eq(h.entries.length, 2, "quit must stop recapping");
});

await test("session_start resets per-session state", async () => {
	const h = createHarness();
	await h.emitShutdown("quit");
	h.setSessionId("session-2");
	await h.startSession();
	h.setBranch([userEntry("after restart", "u2"), assistantEntry("Ok.", "a2")]);
	await h.emitAuto();
	await quiesce();
	eq(h.entries.length, 1, "recaps should resume after session_start");
});

await test("ui-less modes (print/json) never summarise automatically", async () => {
	const h = createHarness({ hasUI: false });
	await h.emitAuto();
	await quiesce();
	eq(h.entries.length, 0, "no recap without UI");
});

// ---------------------------------------------------------------------------

rmSync(coreStubPath, { force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
	console.log(`\nFailures:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
	process.exit(1);
}
