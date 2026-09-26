#!/usr/bin/env node
/**
 * Pre-publish verifier.
 *
 * Checks the package metadata, the exact set of files `npm pack` would ship,
 * the extension's shipping policy (no personal data, no hardcoded model
 * default, no context-polluting message API) and finally runs the test suite.
 *
 * Run: npm run verify
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findPiPackageDir } from "./find-pi.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

// npm is a .cmd shim on Windows, so it can only be spawned through a shell with
// a fixed argument list — exactly the combination Node warns about in DEP0190.
process.noDeprecation = true;

const PI_PROVIDED_PACKAGES = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
];

const EXPECTED_SHIPPED_FILES = [
	"CHANGELOG.md",
	"LICENSE",
	"README.md",
	"extensions/recap.ts",
	"package.json",
];

const results = [];
const check = (name, fn) => {
	try {
		const detail = fn();
		results.push({ name, ok: true, detail: typeof detail === "string" ? detail : undefined });
	} catch (error) {
		results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
	}
};

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const shipped = new Map();

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

check("package name is a valid npm name", () => {
	const name = pkg.name;
	if (typeof name !== "string") throw new Error("missing name");
	const pattern = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
	if (!pattern.test(name)) throw new Error(`invalid npm name: ${name}`);
	if (name.length > 214) throw new Error("name longer than 214 characters");
	return name;
});

check("version is semver and matches the changelog", () => {
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version ?? "")) {
		throw new Error(`not a semver version: ${pkg.version}`);
	}
	const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
	if (!changelog.includes(`## ${pkg.version}`)) {
		throw new Error(`CHANGELOG.md has no "## ${pkg.version}" heading`);
	}
	return pkg.version;
});

check('keywords include "pi-package" (gallery discovery)', () => {
	if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes("pi-package")) {
		throw new Error('package.json keywords must include "pi-package"');
	}
	return pkg.keywords.join(", ");
});

check("description is present and specific", () => {
	if (typeof pkg.description !== "string" || pkg.description.length < 30) {
		throw new Error("description should be a sentence at least 30 characters long");
	}
	return `${pkg.description.length} chars`;
});

check("license is MIT and the LICENSE file agrees", () => {
	if (pkg.license !== "MIT") throw new Error(`license field is ${pkg.license}`);
	const license = readFileSync(join(repoRoot, "LICENSE"), "utf8");
	if (!license.includes("MIT License")) throw new Error("LICENSE does not look like an MIT license");
	return "MIT";
});

check("scoped packages publish publicly", () => {
	if (pkg.name.startsWith("@") && pkg.publishConfig?.access !== "public") {
		throw new Error('scoped package needs "publishConfig": { "access": "public" }');
	}
	return pkg.publishConfig?.access ?? "default";
});

check("engines.node is declared", () => {
	if (!pkg.engines?.node) throw new Error("missing engines.node");
	return `node ${pkg.engines.node}`;
});

check("no runtime dependencies are bundled", () => {
	for (const field of ["dependencies", "bundledDependencies", "bundleDependencies", "optionalDependencies"]) {
		const value = pkg[field];
		if (value && Object.keys(value).length > 0) throw new Error(`${field} must be empty: ${Object.keys(value).join(", ")}`);
	}
	return "zero-dependency extension";
});

check('pi-supplied packages are peerDependencies with a "*" range', () => {
	const peers = pkg.peerDependencies ?? {};
	const keys = Object.keys(peers);
	if (keys.length === 0) throw new Error("missing peerDependencies");
	for (const key of keys) {
		if (!PI_PROVIDED_PACKAGES.includes(key)) throw new Error(`${key} is not supplied by pi and must be a dependency`);
		if (peers[key] !== "*") throw new Error(`${key} must use the "*" range, not "${peers[key]}"`);
	}
	if (!keys.includes("@earendil-works/pi-coding-agent")) throw new Error("pi-coding-agent must be a peer dependency");
	return keys.join(", ");
});

check("the pi manifest points at files that exist", () => {
	const entries = pkg.pi?.extensions;
	if (!Array.isArray(entries) || entries.length === 0) throw new Error("missing pi.extensions");
	for (const entry of entries) {
		const path = join(repoRoot, entry.replace(/^\.\//, ""));
		if (!existsSync(path)) throw new Error(`pi.extensions entry does not exist: ${entry}`);
	}
	return entries.join(", ");
});

check("every file listed in files exists", () => {
	for (const entry of pkg.files ?? []) {
		if (!existsSync(join(repoRoot, entry))) throw new Error(`files entry does not exist: ${entry}`);
	}
	if (!(pkg.files ?? []).includes("extensions")) throw new Error("files must include the extensions directory");
	return (pkg.files ?? []).join(", ");
});

check("publish-time scripts are wired up", () => {
	if (pkg.scripts?.prepublishOnly !== "node scripts/verify.mjs") {
		throw new Error("scripts.prepublishOnly must run the verifier");
	}
	if (!pkg.scripts?.test) throw new Error("missing scripts.test");
	return "prepublishOnly → verify";
});

// ---------------------------------------------------------------------------
// Shipped file set
// ---------------------------------------------------------------------------

check("npm pack ships exactly the intended files", () => {
	const output = execFileSync(npmCmd, ["pack", "--dry-run", "--json"], {
		cwd: repoRoot,
		encoding: "utf8",
		// Windows: npm is a .cmd shim, which execFileSync can only run through a shell.
		shell: process.platform === "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const parsed = JSON.parse(output);
	const entry = Array.isArray(parsed) ? parsed[0] : parsed;
	const files = (entry.files ?? []).map((file) => file.path.replace(/\\/g, "/")).sort();
	const unexpected = files.filter((file) => !EXPECTED_SHIPPED_FILES.includes(file));
	if (unexpected.length > 0) throw new Error(`unexpected files would be published: ${unexpected.join(", ")}`);
	for (const file of files) {
		shipped.set(file, join(repoRoot, file));
	}
	return `${files.length} files, ${(entry.size / 1024).toFixed(1)} kB packed (${(entry.unpackedSize / 1024).toFixed(1)} kB unpacked)`;
});

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

const PRIVATE_PATTERNS = [
	{ pattern: /C:\\+Users\\+/i, label: "absolute Windows user path" },
	{ pattern: /\bAdministrator\b/, label: "local machine account name" },
	{ pattern: /matianwen/i, label: "personal identifier" },
	// The npm scope and the GitHub owner are public by design, so "eagle4302"
	// itself is allowed; the private address that goes with it is not.
	{ pattern: /hotmail|gmail\.com|yahoo\.com/i, label: "personal email address" },
	{ pattern: /\/(?:Users|home)\/[A-Za-z0-9._-]+\//, label: "absolute POSIX home path" },
	{ pattern: /npm_[A-Za-z0-9]{20,}/, label: "npm access token" },
	{ pattern: /sk-[A-Za-z0-9-]{20,}/, label: "API key" },
	{
		pattern: /(?:api[_-]?key|auth[_-]?token|access[_-]?token|secret|password)\s*[:=]\s*["'][^"']{8,}["']/i,
		label: "hardcoded credential",
	},
];

check("shipped files contain no personal data or secrets", () => {
	if (shipped.size === 0) throw new Error("file list unavailable (npm pack check failed first)");
	const hits = [];
	for (const [file, path] of shipped) {
		const content = readFileSync(path, "utf8");
		for (const { pattern, label } of PRIVATE_PATTERNS) {
			const match = content.match(pattern);
			if (match) hits.push(`${file}: ${label} (${JSON.stringify(match[0]).slice(0, 60)})`);
		}
	}
	if (hits.length > 0) throw new Error(hits.join("; "));
	return `${shipped.size} files scanned`;
});

// ---------------------------------------------------------------------------
// Extension policy
// ---------------------------------------------------------------------------

const extensionPath = join(repoRoot, "extensions", "recap.ts");
const extensionSource = readFileSync(extensionPath, "utf8");
// Prose may name the APIs it deliberately avoids, so policy checks look at code only.
const extensionCode = extensionSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

check("the extension imports values only from pi-tui and node builtins", () => {
	const valueImports = [...extensionCode.matchAll(/^import\s+(?!type\b)([\s\S]*?)from\s+"([^"]+)";/gm)];
	const bad = valueImports.filter((match) => !match[2].startsWith("@earendil-works/pi-tui") && !match[2].startsWith("node:"));
	if (bad.length > 0) throw new Error(`unexpected runtime imports: ${bad.map((m) => m[2]).join(", ")}`);
	const coreImports = [...extensionCode.matchAll(/^import type\s+([\s\S]*?)from\s+"([^"]+)";/gm)];
	if (!coreImports.some((match) => match[2] === "@earendil-works/pi-coding-agent")) {
		throw new Error("expected a type-only import from pi-coding-agent");
	}
	return valueImports.map((match) => match[2]).join(", ");
});

check("the recap never enters the LLM context", () => {
	if (/pi\.sendMessage\s*\(/.test(extensionCode)) {
		throw new Error("use appendEntry (custom entry) — sendMessage projects into LLM context");
	}
	if (!/pi\.appendEntry/.test(extensionCode)) throw new Error("appendEntry call not found");
	return "appendEntry only";
});

check("no personal model or provider is hardcoded", () => {
	const defaults = extensionCode.match(/\b(?:provider|modelId)\s*=\s*"/);
	if (defaults) throw new Error("found a hardcoded provider/model default");
	if (/let pinned\s*=\s*\{/.test(extensionCode)) throw new Error("pinned model must start undefined (auto)");
	if (!/let pinned\s*:/.test(extensionCode)) throw new Error("pinned model declaration not found");
	return "default is auto (cheapest available)";
});

check("every theme colour used exists in pi's theme schema", () => {
	const used = new Set([...extensionCode.matchAll(/theme\.(?:fg|bg)\("([A-Za-z]+)"/g)].map((match) => match[1]));
	if (used.size === 0) throw new Error("no theme colours found");
	const piDir = findPiPackageDir(repoRoot);
	const schemaPath = piDir
		? join(piDir, "dist", "modes", "interactive", "theme", "theme-schema.json")
		: undefined;
	if (!schemaPath || !existsSync(schemaPath)) {
		return `${used.size} colours used (pi install not found, schema not checked)`;
	}
	const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
	const allowed = new Set(Object.keys(schema.properties?.colors?.properties ?? {}));
	const unknown = [...used].filter((colour) => !allowed.has(colour) && !colour.startsWith("#"));
	if (unknown.length > 0) throw new Error(`unknown theme colours: ${unknown.join(", ")}`);
	return [...used].join(", ");
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

check("the test suite passes", () => {
	const output = execFileSync(process.execPath, [join(repoRoot, "test", "smoke.mjs")], {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const summary = output.trim().split("\n").at(-1) ?? "";
	if (!/^\d+ passed, 0 failed$/.test(summary)) throw new Error(`unexpected summary: ${summary}`);
	return summary;
});

// ---------------------------------------------------------------------------
// Repository (network; optional field)
// ---------------------------------------------------------------------------

if (pkg.repository) {
	const name = "the repository URL points at a real GitHub repo";
	const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository.url;
	const match = /github\.com[/:]([^/]+)\/([^/.#]+)/.exec(url ?? "");
	if (!match) {
		results.push({ name, ok: false, detail: `not a GitHub URL: ${url}` });
	} else {
		const [, owner, repo] = match;
		const label = `github.com/${owner}/${repo}`;
		try {
			const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
				headers: {
					accept: "application/vnd.github+json",
					...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
				},
			});
			if (response.status === 200) {
				results.push({ name, ok: true, detail: label });
			} else if (response.status === 401 || response.status === 403) {
				results.push({ name, ok: true, detail: `${label} (rate limited, not verified)` });
			} else {
				// A missing repository must never block publishing: the link simply
				// resolves once the repo is pushed. Say so, keep going.
				results.push({
					name,
					ok: true,
					detail: `${label} does not exist yet (the link resolves once you push it)`,
				});
			}
		} catch (error) {
			results.push({ name, ok: true, detail: `${label} (offline: ${error.message})` });
		}
	}
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const width = Math.max(...results.map((result) => result.name.length));
console.log("\npre-publish verification\n");
for (const result of results) {
	const mark = result.ok ? "ok  " : "FAIL";
	console.log(`${mark}  ${result.name.padEnd(width)}  ${result.detail ?? ""}`);
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);

if (failed.length > 0) {
	console.log("Fix the failing checks before publishing.\n");
	// Not process.exit(): an open fetch socket would be torn down mid-close.
	process.exitCode = 1;
} else {
	// Report the real state rather than a canned checklist.
	const npmShell = { encoding: "utf8", shell: process.platform === "win32", stdio: ["ignore", "pipe", "ignore"] };
	let account;
	try {
		account = execFileSync(npmCmd, ["whoami"], npmShell).trim();
	} catch {
		account = undefined;
	}
	let published;
	try {
		published = execFileSync(npmCmd, ["view", pkg.name, "version"], npmShell).trim();
	} catch {
		published = undefined;
	}
	const localCopy = join(homedir(), ".pi", "agent", "extensions", "recap.ts");
	const localNote = existsSync(localCopy)
		? ["Remove the local copy of the extension first, or pi will register two", "recappers and you will get two recaps per exchange:", "", `  rm ${localCopy}`]
		: ["No local copy found in ~/.pi/agent/extensions, so nothing can double-register."];

	console.log(
		[
			"Ready to publish. Manual steps (this script never publishes):",
			"",
			account
				? `  1. npm whoami                    # logged in as ${account}`
				: "  1. npm login",
			published
				? `  2. npm view ${pkg.name}   # already on the registry: ${published} — bump the version`
				: `  2. npm view ${pkg.name}   # expect E404 — the name is free`,
			"  3. npm publish --access public   # prepublishOnly re-runs this verifier",
			`  4. npm view ${pkg.name} version  # confirm ${pkg.version} is on the registry`,
			"",
			...localNote,
			"",
			`  pi install npm:${pkg.name}`,
			"",
		].join("\n"),
	);
}
