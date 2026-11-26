#!/usr/bin/env node

// silo's files read by a program that isn't silo: no @brianjenkins94/util, only what packages/silo/README.md's *The
// files* says of each. If this can't read what silo writes, the contract is wrong, or the README is (files.test.ts).
// `node reader.mjs <repo>` prints what it read.

import * as fs from "node:fs";
import * as path from "node:path";

const VERSIONS = {
	"features": 1,
	"baseline": 1,
	"runs": 1,
	"vouches": 1
};

function textOf(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function filesUnder(folder, suffix) {
	if (!fs.existsSync(folder)) {
		return [];
	}

	return fs.readdirSync(folder, { "recursive": true, "withFileTypes": true }).filter((entry) => entry.isFile() && entry.name.endsWith(suffix)).map((entry) => path.join(entry.parentPath, entry.name)).toSorted();
}

function linesOf(text) {
	return text.split("\n").filter((line) => line.trim() !== "").flatMap((line) => {
		try {
			const value = JSON.parse(line);

			return typeof value === "object" && value !== null && !Array.isArray(value)
				? [value]
				: [];
		} catch {
			return [];
		}
	});
}

function lineFile(silo, folder, version, isOne) {
	const read = [];
	let skipped = 0;

	for (const file of filesUnder(path.join(silo, folder), ".jsonl")) {
		const owner = path.relative(path.join(silo, folder), file).split(path.sep)[0].replace(/\.jsonl$/u, "");

		for (const line of linesOf(fs.readFileSync(file, "utf8"))) {
			if (!isOne(line)) {
				continue;
			}

			if (line.version === undefined || line.version === version) {
				read.push({ ...line, "file": owner });
			} else {
				skipped += 1;
			}
		}
	}

	return { "read": read, "skipped": skipped };
}

function wholeFile(file, version, versionKey) {
	const text = textOf(file);

	if (text === undefined) {
		return undefined;
	}

	const value = JSON.parse(text);
	const stated = value[versionKey];

	if (stated !== undefined && stated !== version) {
		throw new Error(`${file} is version ${String(stated)}; this reader reads version ${String(version)}`);
	}

	return value;
}

export function readSilo(repo) {
	const silo = path.join(repo, ".silo");
	const ledger = wholeFile(path.join(silo, "features.json"), VERSIONS.features, "$version");
	const baseline = wholeFile(path.join(silo, "baseline.json"), VERSIONS.baseline, "version");
	const policy = wholeFile(path.join(silo, "policy.json"), 1, "version");
	const reach = wholeFile(path.join(silo, "last-run", "reach.json"), 2, "version");
	const versions = wholeFile(path.join(silo, "versions.json"), 3, "format");
	const runs = lineFile(silo, "runs", VERSIONS.runs, (line) => line.type === "run" && typeof line.id === "string");
	const vouches = lineFile(silo, "vouches", VERSIONS.vouches, (line) => typeof line.test === "string" && typeof line.reached === "object");
	const evidence = filesUnder(path.join(silo, "evidence"), ".jsonl").flatMap((file) => {
		const [user, environment, ...rest] = path.relative(path.join(silo, "evidence"), file).split(path.sep);

		return linesOf(fs.readFileSync(file, "utf8")).filter((line) => typeof line.span === "string" && typeof line.kind === "string").map((line) => ({
			"user": user,
			"environment": environment,
			"of": rest.join("/").replace(/\.jsonl$/u, ""),
			"kind": line.kind,
			"span": line.span,
			"key": line.key
		}));
	});
	const notes = filesUnder(path.join(silo, "notes"), ".jsonl").flatMap((file) => {
		const [user, ...rest] = path.relative(path.join(silo, "notes"), file).split(path.sep);
		const latest = new Map();

		for (const line of linesOf(fs.readFileSync(file, "utf8"))) {
			if (typeof line.id === "string" && typeof line.updatedAt === "string" && line.ref !== undefined && !(line.updatedAt < (latest.get(line.id)?.updatedAt ?? ""))) {
				latest.set(line.id, line);
			}
		}

		return [
			...latest.values()
		].filter((line) => line.dismissed !== true).map((line) => ({
			"user": user,
			"of": rest.join("/").replace(/\.jsonl$/u, ""),
			"id": line.id
		}));
	});

	return {
		"features": ledger === undefined
			? undefined
			: Object.fromEntries(Object.entries(ledger).filter(([name]) => name !== "$version").map(([name, entry]) => [
					name,
					{
						"status": entry.status,
						"why": entry.why,
						"paths": entry.paths ?? [],
						"tests": entry.tests ?? [],
						"ways": entry.ways ?? []
					}
				])),
		"baseline": baseline === undefined
			? undefined
			: {
					"packages": Object.keys(baseline.packages ?? {}).toSorted(),
					"uses": Object.values(baseline.consumer ?? {}).reduce((total, workspace) => total + Object.keys(workspace).length, 0)
				},
		"policy": policy === undefined
			? undefined
			: { "rules": (policy.rules ?? []).length },
		"reach": reach === undefined
			? undefined
			: {
					"tests": (reach.tests ?? []).length,
					"files": Object.keys(reach.files ?? {}).toSorted()
				},
		"versions": versions === undefined
			? undefined
			: Object.keys(versions.packages ?? {}).toSorted(),
		"runs": {
			"ids": runs.read.map((run) => run.id),
			"skipped": runs.skipped
		},
		"vouches": {
			"tests": vouches.read.map((vouch) => `${vouch.file}: ${vouch.test} ${vouch.outcome}`),
			"skipped": vouches.skipped
		},
		"evidence": evidence.map((each) => `${each.user}/${each.environment} ${each.of} ${each.kind} ${each.span}`),
		"notes": notes.map((each) => `${each.user} ${each.of} ${each.id}`)
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	process.stdout.write(JSON.stringify(readSilo(process.argv[2] ?? process.cwd()), undefined, "\t") + "\n");
}
