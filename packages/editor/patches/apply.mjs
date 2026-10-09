/**
 * Apply the dependency patches in this folder after install (the package's `postinstall`).
 *
 * The patch files are in pnpm's `patchedDependencies` format (`<name>@<version>.patch`, `a/`–`b/` paths relative to
 * the package root), but pnpm can't apply them itself here: editor commits no pnpm-workspace.yaml (CI writes an
 * ephemeral one over it), and pnpm 11+ no longer reads `package.json#pnpm`. So this applies them, idempotently:
 *
 *   - already applied (the patch reverses cleanly) → skip;
 *   - applies cleanly → apply, first COPYING each target so a file hardlinked into the pnpm store is replaced
 *     rather than edited in place (editing it would silently patch the shared store for every other project);
 *   - neither (the installed version drifted, or upstream changed) → fail the install loudly.
 *
 * The installed version must match the patch's exactly; package.json pins it so a caret bump can't slip past.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, realpathSync, renameSync } from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.dirname(here);

/** Resolve an installed package's directory by walking up node_modules from the package root. */
function packageDir(name) {
	for (let dir = root; ; dir = path.dirname(dir)) {
		const candidate = path.join(dir, "node_modules", name);

		if (existsSync(path.join(candidate, "package.json"))) {
			return realpathSync(candidate);
		}

		if (path.dirname(dir) === dir) {
			return undefined;
		}
	}
}

function patchSucceeds(dir, patchFile, reverse) {
	try {
		execFileSync("patch", ["-p1", "-f", "-s", "--dry-run", ...(reverse ? ["-R"] : ["-N"]), "-i", patchFile], { "cwd": dir, "stdio": "ignore" });

		return true;
	} catch {
		return false;
	}
}

for (const file of readdirSync(here).filter((entry) => entry.endsWith(".patch"))) {
	const [, name, version] = /^(.+)@([^@]+)\.patch$/u.exec(file) ?? [];
	const packageName = name.replace("__", "/");
	const patchFile = path.join(here, file);
	const dir = packageDir(packageName);

	if (dir === undefined) {
		console.warn("[patches] " + packageName + " is not installed; skipping " + file);
		continue;
	}

	const installed = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).version;

	if (installed !== version) {
		throw new Error("[patches] " + file + " targets " + packageName + "@" + version + " but " + installed + " is installed — update the patch (and the pin in package.json)");
	}

	if (patchSucceeds(dir, patchFile, true)) {
		continue; // already applied
	}

	if (!patchSucceeds(dir, patchFile, false)) {
		throw new Error("[patches] " + file + " no longer applies to " + dir);
	}

	// Break any hardlink into the pnpm store before editing: copy aside, then rename the copy over the original.
	for (const [, target] of readFileSync(patchFile, "utf8").matchAll(/^\+\+\+ b\/(.+)$/gmu)) {
		const targetFile = path.join(dir, target);

		copyFileSync(targetFile, targetFile + ".unlinked");
		renameSync(targetFile + ".unlinked", targetFile);
	}

	execFileSync("patch", ["-p1", "-f", "-s", "-N", "-i", patchFile], { "cwd": dir, "stdio": "inherit" });
	console.log("[patches] applied " + file);
}
