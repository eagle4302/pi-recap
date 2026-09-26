/**
 * Locate the installed pi coding agent package directory.
 *
 * Resolution order:
 *   1. $PI_PACKAGE_DIR
 *   2. <repo>/node_modules/@earendil-works/pi-coding-agent
 *   3. platform npm global prefixes (APPDATA, HOME, /usr/local/lib, ...)
 *   4. PATH entries and their node_modules siblings (the global bin directory
 *      lives next to node_modules on a typical npm install)
 *
 * Returns undefined when pi is not installed.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

const RELATIVE = ["@earendil-works", "pi-coding-agent"];

const isPiPackage = (dir) => Boolean(dir) && existsSync(join(dir, "package.json"));

export function findPiPackageDir(repoRoot) {
	const candidates = [];
	if (process.env.PI_PACKAGE_DIR) candidates.push(process.env.PI_PACKAGE_DIR);
	candidates.push(join(repoRoot, "node_modules", ...RELATIVE));

	const roots = [];
	if (process.env.APPDATA) roots.push(join(process.env.APPDATA, "npm", "node_modules"));
	if (process.env.HOME) {
		roots.push(join(process.env.HOME, ".npm-global", "lib", "node_modules"));
		roots.push(join(process.env.HOME, ".local", "share", "npm", "lib", "node_modules"));
		roots.push(join(process.env.HOME, ".local", "lib", "node_modules"));
	}
	roots.push("/usr/local/lib/node_modules", "/usr/lib/node_modules", "/opt/homebrew/lib/node_modules");

	for (const entry of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
		if (!entry) continue;
		roots.push(join(entry, "node_modules"));
		roots.push(entry);
		roots.push(join(entry, "lib", "node_modules"));
	}

	for (const root of roots) candidates.push(join(root, ...RELATIVE));

	for (const candidate of candidates) {
		if (isPiPackage(candidate)) return candidate;
		// Global installs sometimes nest pi's own dependency tree.
		const nested = join(candidate, "node_modules", ...RELATIVE);
		if (isPiPackage(nested)) return nested;
	}
	return undefined;
}
