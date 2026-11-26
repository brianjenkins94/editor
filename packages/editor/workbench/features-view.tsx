/** @jsxImportSource preact */
import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type { Ledger, LedgerEntry } from "@brianjenkins94/util/silo/ledger";
import type { TestStanding } from "@brianjenkins94/util/silo/outcomes";
import type { JSX } from "preact";
import type * as vscodeApi from "vscode";
import type { Contention, Kind, RunRecord, Slower, Why } from "./test-runs";
import { registerCustomView, ViewContainerLocation } from "@brianjenkins94/monaco-vscode-api/main";
import { createRpcClient } from "@brianjenkins94/hub";
import { ledgerPath } from "@brianjenkins94/util/silo/layout";
import { isOwnedCode, ownersOf, parseLedger } from "@brianjenkins94/util/silo/ledger";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { featuresViewStyles } from "theme/styles/features-view";
import { capabilitiesOf } from "./capability-confirm";
import { fileOf, titlesOf } from "./ci-outcomes";
import { contentionsOf, kindOf, slowerOf } from "./test-runs";
import { isTestFile } from "./terminal/commands/node/node";
import "theme/components/badge";
import "theme/components/button";
import "theme/components/checkbox";
import "theme/components/input";
import "theme/components/relative-time";
import "theme/components/spinner";

const ROOT = "/workspace";


interface Answer { "run"?: string; "running"?: string; "ask"?: { "message": string; "key": string } }

interface Model {
	"features": [string, LedgerEntry][];
	"files": Map<string, string[]>;
	"kinds": Map<string, Kind>;
	"history": RunRecord[];
	"reach": Map<string, { "lines": number; "only": number }>;
	"touched": Set<string>;
	"unchecked": Record<"not run" | "lines not run" | "config", string[]>;
	"slowerBy": number;
	"titles": Map<string, Set<string | RegExp>>;
	"ci": { "byFile": Map<string, TestStanding[]>; "runs": number; "refused"?: string };
	"coverage": Map<string, FeatureCoverage>;
	"capabilities": Map<string, FeatureCapabilities>;
	"tools"?: ToolUses;
}

interface ToolUse { "tool": string; "via": "editor" | "around"; "calls": number; "failures": number; "ms": number; "last": number }

interface Finding { "kind": "bypass" | "candidate" | "workaround" | "friction" | "oversize"; "tool": string; "count": number; "said": string }

interface ToolUses { "since"?: number; "tools": ToolUse[]; "findings"?: Finding[] }

const FINDING_VARIANT: Record<Finding["kind"], "warning" | "danger" | "neutral" | "brand"> = { "bypass": "warning", "candidate": "brand", "workaround": "warning", "friction": "danger", "oversize": "neutral" };

const FINDING_TITLE: Record<Finding["kind"], string> = {
	"bypass": "Done around the editor while it was linked, though an editor tool does it: use that one, or say why it wasn't enough.",
	"candidate": "Run often in the shell while the editor was linked, and no editor tool does it: a tool to write, its UI first.",
	"workaround": "A page's eval standing in for something: what was missing?",
	"friction": "A tool that fails often: what it's asked for, or how it answers, needs fixing.",
	"oversize": "An answer bigger than is read whole: it needs paging, a summary, or a narrower ask."
};

const AGENT_TOOL = "agent tool|";

const toolsOf = (entry: LedgerEntry): string[] => (entry.ways ?? []).filter((way) => way.startsWith(AGENT_TOOL)).map((way) => way.slice(AGENT_TOOL.length));

const useLine = ({ tool, calls, failures, ms, last }: ToolUse): string => `${tool}: ${String(calls)} ${calls === 1 ? "call" : "calls"}${failures === 0 ? "" : `, ${String(failures)} failed`}, ${lasted(ms / calls)} each, last ${new Date(last).toLocaleString()}`;

function AgentTools({ entry, uses }: { "entry": LedgerEntry; "uses": ToolUses | undefined }): JSX.Element | null {
	const tools = toolsOf(entry);

	if (tools.length === 0) {
		return null;
	}

	if (uses === undefined) {
		return <span title={`Its agent tools: ${tools.join(", ")}. How they're used is debug-mcp's to say, and none is linked.`}>{`${String(tools.length)} agent ${tools.length === 1 ? "tool" : "tools"}`}</span>;
	}

	const byTool = new Map(uses.tools.filter((use) => use.via === "editor").map((use) => [use.tool, use]));
	const used = tools.flatMap((tool) => byTool.get(tool) ?? []);
	const never = tools.filter((tool) => !byTool.has(tool));
	const calls = used.reduce((total, use) => total + use.calls, 0);
	const failures = used.reduce((total, use) => total + use.failures, 0);

	return (
		<span class="wa-cluster wa-gap-3xs">
			<span title={used.toSorted((one, other) => other.calls - one.calls).map(useLine).join("\n") || "None of its agent tools has been called."}>{`${String(tools.length)} agent ${tools.length === 1 ? "tool" : "tools"} · ${String(calls)} ${calls === 1 ? "call" : "calls"}`}</span>
			{failures === 0 ? null : <wa-badge appearance="outlined" variant="danger" title={used.filter((use) => use.failures > 0).map(useLine).join("\n")}>{`${String(failures)} failed`}</wa-badge>}
			{never.length === 0 ? null : <wa-badge appearance="outlined" variant="warning" title={`Never called by an agent: ${never.join(", ")}. Not needed, or not found when it would help.`}>{`${String(never.length)} never called`}</wa-badge>}
		</span>
	);
}

function Unnamed({ features, uses }: { "features": [string, LedgerEntry][]; "uses": ToolUses | undefined }): JSX.Element | null {
	if (uses === undefined || uses.tools.length === 0) {
		return null;
	}

	const named = new Set(features.flatMap(([, entry]) => toolsOf(entry)));
	const unnamed = uses.tools.filter((use) => use.via === "around" || !named.has(use.tool));
	const since = uses.since === undefined ? "" : ` since ${new Date(uses.since).toLocaleDateString()}`;

	return (
		<div class="wa-stack wa-gap-3xs">
			<div class="wa-caption-s" title={unnamed.map(useLine).join("\n")}>
				{`Agents' tool calls${since}: ${String(uses.tools.reduce((total, use) => total + use.calls, 0))}. Called, in no feature: ${unnamed.length === 0 ? "none" : unnamed.slice(0, 8).map((use) => `${use.tool} ${String(use.calls)}`).join(", ")}${unnamed.length > 8 ? ", …" : ""}`}
			</div>
			{(uses.findings ?? []).slice(0, 8).map((finding) => (
				<div key={`${finding.kind} ${finding.tool}`} class="wa-cluster wa-gap-2xs wa-caption-s">
					<wa-badge appearance="outlined" variant={FINDING_VARIANT[finding.kind]} title={FINDING_TITLE[finding.kind]}>{finding.kind}</wa-badge>
					<span>{finding.said}</span>
				</div>
			))}
		</div>
	);
}

interface FeatureCapabilities { "can": string[]; "used": string[] }

function capabilitiesByFeature(ledger: Ledger, canOf: Map<string, string[]>, history: RunRecord[], files: Map<string, string[]>): Map<string, FeatureCapabilities> {
	const byFeature = new Map<string, FeatureCapabilities>();
	const last = new Map(history.map((run) => [run.file, run]));

	for (const [file, can] of canOf) {
		if (!isTestFile(file)) {
			for (const owner of ownersOf(ledger, file)) {
				const its = byFeature.get(owner) ?? { "can": [], "used": [] };

				its.can = [...new Set([...its.can, ...can])].toSorted();
				byFeature.set(owner, its);
			}
		}
	}

	for (const [feature, its] of byFeature) {
		its.used = [
			...new Set((files.get(feature) ?? []).flatMap((test) => last.get(test)?.effects ?? []).filter((effect) => effect.how !== "denied" && effect.how !== "skipped").map((effect) => effect.capability))
		].toSorted();
	}

	return byFeature;
}

function Capabilities({ of }: { "of": FeatureCapabilities | undefined }): JSX.Element | null {
	if (of === undefined || of.can.length === 0) {
		return null;
	}

	const unseen = of.can.filter((capability) => !of.used.includes(capability));

	return (
		<span class="wa-cluster wa-gap-3xs">
			<span title="What its own code can do, as its text says: a capability, not what it reaches.">{`can ${of.can.join(", ")}`}</span>
			{unseen.length === 0 ? null : <wa-badge appearance="outlined" variant="warning" title="What its code can do that no last run of its tests did: untested here, or no longer needed.">{`${unseen.join(", ")} not in its tests' runs`}</wa-badge>}
		</span>
	);
}

interface FeatureCoverage { "statements": number; "ran": number; "unloaded": string[]; "shared": Map<string, string[]> }

function coverageByFeature(ledger: Ledger, code: string[], ofFile: Record<string, { "statements": number; "ran": number; "by"?: string[] }>, featuresOf: Map<string, string[]>): Map<string, FeatureCoverage> {
	const byFeature = new Map<string, FeatureCoverage>();

	for (const file of code) {
		for (const owner of ownersOf(ledger, file)) {
			const its = byFeature.get(owner) ?? { "statements": 0, "ran": 0, "unloaded": [], "shared": new Map() };
			const counted = ofFile[file];

			if (counted === undefined) {
				its.unloaded.push(file);
			} else {
				its.statements += counted.statements;
				its.ran += counted.ran;

				const others = [...new Set((counted.by ?? []).flatMap((test) => featuresOf.get(test) ?? []))].filter((feature) => feature !== owner).toSorted();

				if (others.length > 0) {
					its.shared.set(file, others);
				}
			}

			byFeature.set(owner, its);
		}
	}

	return byFeature;
}

const featuresOfTests = (files: Map<string, string[]>): Map<string, string[]> => new Map([
	...Map.groupBy([...files].flatMap(([feature, tests]) => tests.map((test) => [test, feature] as const)), ([test]) => test)
].map(([test, pairs]) => [test, pairs.map(([, feature]) => feature)]));

function Covered({ coverage }: { "coverage": FeatureCoverage | undefined }): JSX.Element | null {
	if (coverage === undefined) {
		return null;
	}

	const { statements, ran, unloaded, shared } = coverage;

	return (
		<span class="wa-cluster wa-gap-3xs">
			{statements === 0 ? null : <span title={`${String(ran)} of the ${String(statements)} statements in its code that tests here loaded ran, over each test file's last run.`}>{`${String(Math.floor((ran / statements) * 100))}% of its code run`}</span>}
			{unloaded.length === 0 ? null : <wa-badge appearance="outlined" variant="warning" title={unloaded.join("\n")}>{`${String(unloaded.length)} ${unloaded.length === 1 ? "file" : "files"} no test loads`}</wa-badge>}
			{shared.size === 0 ? null : <wa-badge appearance="outlined" variant="neutral" title={[...shared].map(([file, features]) => `${file}: ${features.join(", ")}`).join("\n")}>{`${String(shared.size)} ${shared.size === 1 ? "file" : "files"} other features' tests run`}</wa-badge>}
		</span>
	);
}

const KIND_TITLE: Record<Kind, string> = {
	"unit": "Runs in the debugger, its code stepped and traced.",
	"UI spec": "Runs in the debugger, driving an editor of its own in a window of its own.",
	"browser suite": "Started from outside the editor, by a real browser: CI's, or node --test here.",
	"not a test": "A helper or fixture the ledger names among its tests."
};

const median = (values: number[]): number | undefined => values.toSorted((one, other) => one - other)[Math.floor(values.length / 2)];

const lasted = (ms: number | undefined): string => (ms === undefined ? "" : ms < 1000 ? `${String(Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`);

const passed = (run: RunRecord): boolean => run.exitCode === 0 && run.tests.length > 0 && run.tests.every((test) => test.outcome === "pass");

const lastWhere = (runs: RunRecord[], well: boolean): RunRecord | undefined => runs.findLast((run) => passed(run) === well);

const isCode = (path: string): boolean => !path.includes("node_modules/") && !isTestFile(path);

function reachOf(reach: Record<string, Record<string, [number, number][]>>): Model["reach"] {
	const byFile = new Map<string, Set<string>>();
	const reachers = new Map<string, Set<string>>();

	for (const [id, files] of Object.entries(reach)) {
		const file = id.split(" › ")[0];
		const lines = byFile.get(file) ?? new Set();

		byFile.set(file, lines);

		for (const [code, ranges] of Object.entries(files).filter(([path]) => isCode(path))) {
			for (const [from, to] of ranges) {
				for (let line = from; line <= to; line += 1) {
					const key = `${code}:${String(line)}`;

					lines.add(key);
					reachers.set(key, (reachers.get(key) ?? new Set()).add(file));
				}
			}
		}
	}

	return new Map([...byFile].map(([file, lines]) => [file, { "lines": lines.size, "only": [...lines].filter((key) => reachers.get(key)?.size === 1).length }]));
}

function blockOf(kind: Kind, contentions: Contention[] | undefined): { "said": string; "title"?: string } | undefined {
	if (kind === "browser suite") {
		return { "said": "started from outside" };
	}

	const all = contentions ?? [];
	const [first] = all;

	return first === undefined
		? undefined
		: {
				"said": `${first.touches} ${first.resource}, which ${nameOf(first.other)} ${first.otherTouches}${all.length > 1 ? ` (+${String(all.length - 1)})` : ""}`,
				"title": all.map(saidOf).join("\n")
			};
}

const nameOf = (file: string): string => file.split("/").at(-1) ?? file;

const saidOf = (contention: Contention): string => `${contention.test === undefined ? "the file" : `"${contention.test.split(" › ").slice(1).join(" › ")}"`} ${contention.touches} ${contention.resource}; ${contention.otherTest === undefined ? nameOf(contention.other) : `${nameOf(contention.other)}'s "${contention.otherTest.split(" › ").slice(1).join(" › ")}"`} ${contention.otherTouches} it`;

const shapeOf = ({ capability, resource }: RunRecord["effects"][number]): string => `${capability} ${resource.replace(/^(\/tmp\/[^/]*?)-?[A-Za-z0-9]{6}(?=\/|$)/u, "$1*").replace(/\?.*$/u, "")}`;

function Effects({ effects, before }: { "effects": RunRecord["effects"] | undefined; "before": RunRecord["effects"] | undefined }): JSX.Element | null {
	const byKind = Map.groupBy(effects ?? [], (effect) => effect.capability);
	const was = new Set(before?.map(shapeOf));
	const now = new Set(effects?.map(shapeOf));
	const grew = before === undefined ? [] : [...now].filter((shape) => !was.has(shape));
	const shrank = before === undefined ? [] : [...was].filter((shape) => !now.has(shape));

	return (
		<span class="wa-cluster wa-gap-3xs">
			{grew.length === 0 ? null : <wa-badge variant="danger" title={grew.join("\n")}>{`${String(grew.length)} new`}</wa-badge>}
			{shrank.length === 0 ? null : <wa-badge variant="success" title={shrank.join("\n")}>{`${String(shrank.length)} stopped`}</wa-badge>}
			{[...byKind].map(([capability, effects]) => (
				<wa-badge key={capability} appearance="outlined" variant={capability === "page:goto" || capability.endsWith(":write") ? "warning" : "neutral"} title={effects.map((effect) => `${effect.resource} (${String(effect.calls)}×, ${effect.how})`).join("\n")}>
					{capability} {String(effects.length)}
				</wa-badge>
			))}
		</span>
	);
}

function SlowerBadge({ slower }: { "slower": Slower }): JSX.Element {
	const typical = slower.measure === "statements" ? `${String(slower.typical)} statements` : lasted(slower.typical);

	return <wa-badge variant="warning" appearance="outlined" title={`Its last run took ${String(slower.by)}% more ${slower.measure === "statements" ? "statements" : "time"} than its typical ${typical}.`}>{`${String(slower.by)}% slower`}</wa-badge>;
}

function Ci({ standings }: { "standings": TestStanding[] | undefined }): JSX.Element | null {
	if (standings === undefined || standings.length === 0) {
		return null;
	}

	const failing = standings.filter((standing) => standing.last.verdict === "fail").length;
	const flaked = standings.filter((standing) => standing.flakes > 0).length;
	const tried = standings.filter((standing) => standing.last.verdict !== "skip");
	const green = tried.length === 0 ? 0 : Math.min(...tried.map((standing) => standing.streak.runs));
	const title = standings.map((standing) => {
		const failed = standing.lastFailed === undefined ? "" : `, last ${standing.lastFailed.verdict === "fail" ? "failed" : "flaked"} ${standing.lastFailed.at.slice(0, 10)} (${standing.lastFailed.commit.slice(0, 7)})`;

		return `${standing.id}: ${standing.last.verdict}, ${String(standing.streak.runs)} of ${String(standing.runs)} runs in a row${standing.flakes > 0 ? `, flaked in ${String(standing.flakes)}` : ""}${failed}`;
	}).join("\n");

	return (
		<span class="wa-cluster wa-gap-3xs" title={title}>
			{failing > 0 ? <wa-badge variant="danger">{`${String(failing)} failing`}</wa-badge> : tried.length === 0 ? <span>skipped</span> : <span>{`${String(green)} ${green === 1 ? "run" : "runs"} green`}</span>}
			{flaked === 0 ? null : <wa-badge variant="warning" appearance="outlined">{`${String(flaked)} flaked`}</wa-badge>}
		</span>
	);
}

function When({ run }: { "run": RunRecord | undefined }): JSX.Element | null {
	return run === undefined ? null : <wa-relative-time date={run.at} title={run.at} />;
}

const NAMED = 3;

function Unchecked({ label, title, paths }: { "label": string; "title": string; "paths": string[] }): JSX.Element | null {
	if (paths.length === 0) {
		return null;
	}

	const named = paths.slice(0, NAMED).join(", ") + (paths.length > NAMED ? `, and ${String(paths.length - NAMED)} more` : "");

	return <div class="wa-caption-s" title={`${title}\n\n${paths.join("\n")}`}>{`${label}: ${named}`}</div>;
}

function Table({ model, running, onRun, onOpen }: { "model": Model; "running": Set<string>; "onRun": (files: string[]) => void; "onOpen": (file: string) => void }): JSX.Element {
	const [all, setAll] = useState(false);
	const [open, setOpen] = useState<Set<string>>(new Set());
	const [filter, setFilter] = useState("");
	const runsOf = Map.groupBy(model.history, (run) => run.file);
	const contentions = contentionsOf(model.history);

	const runnable = (file: string): boolean => {
		const kind = model.kinds.get(file);

		return kind === "unit" || kind === "UI spec";
	};
	const wanted = filter.trim().toLowerCase();
	const matches = (text: string | undefined): boolean => wanted === "" || (text ?? "").toLowerCase().includes(wanted);
	const filesOf = (name: string, entry: LedgerEntry): string[] => {
		const files = model.files.get(name) ?? [];

		return matches(name) || matches(entry.what) ? files : files.filter((file) => matches(file));
	};
	const shown = model.features.filter(([name, entry]) => (all || (model.files.get(name) ?? []).length > 0) && (wanted === "" || matches(name) || matches(entry.what) || toolsOf(entry).some(matches) || filesOf(name, entry).length > 0));

	return (
		<div class="fv">
			<div class="wa-cluster wa-gap-s">
				<wa-input size="small" placeholder="Filter features and tests" aria-label="Filter features and tests" value={filter} onInput={(event: Event) => { setFilter((event.currentTarget as HTMLInputElement).value); }} />
				<wa-checkbox size="small" checked={all} onChange={() => { setAll(!all); }}>Show features with no tests</wa-checkbox>
				<span class="wa-caption-s">{`${String(shown.length)} of ${String(model.features.length)} features`}</span>
				{model.touched.size === 0 ? null : <wa-button size="small" variant="brand" aria-label="Run touched" onClick={() => { onRun([...model.touched]); }}>{`Run the ${String(model.touched.size)} touched`}</wa-button>}
			</div>
			<Unchecked label="No test here runs" title="Code changed since the last commit that no test's last run here ran: nothing here checks it." paths={model.unchecked["not run"]} />
			<Unchecked label="No test here ran the lines changed in" title="Tests here run these files, but none ran the lines changed since the last commit." paths={model.unchecked["lines not run"]} />
			<Unchecked label="Changed, under every test" title="What every test runs under (its packages, its compiler's settings, what its program may do): any test may come out differently." paths={model.unchecked.config} />
			{model.ci.refused === undefined ? null : <div class="wa-caption-s">{`CI's outcomes: ${model.ci.refused}`}</div>}
			<Unnamed features={model.features} uses={model.tools} />
			<table class="fv-table">
				<thead>
					<tr><th>Test</th><th>Type</th><th>Can't run in parallel</th><th>Effects</th><th>Reach</th><th>Last passed</th><th>Last failed</th><th>Typical</th><th title={`How its tests have come out in CI, over the branch's last ${String(model.ci.runs)} runs that ran tests.`}>CI</th><th /></tr>
				</thead>
				<tbody>
					{shown.flatMap(([name, entry]) => {
						const files = filesOf(name, entry);
						const failing = files.filter((file) => { const last = runsOf.get(file)?.at(-1); return last !== undefined && (last.exitCode !== 0 || last.tests.some((test) => test.outcome !== "pass")); }).length;
						const toRun = files.filter(runnable);

						return [
							<tr key={name} class="fv-feature" title={entry.what ?? entry.why}>
								<td>{name}</td>
								<td colSpan={6}>
									<span class="wa-cluster wa-gap-3xs">
										{entry.status === "active" ? null : <wa-badge appearance="outlined" variant="neutral">{entry.status}</wa-badge>}
										<span>{files.length === 0 ? "no tests" : `${String(files.length)} ${files.length === 1 ? "file" : "files"}`}</span>
										{failing === 0 ? null : <wa-badge variant="danger">{`${String(failing)} failing`}</wa-badge>}
										<Covered coverage={model.coverage.get(name)} />
										<Capabilities of={model.capabilities.get(name)} />
										<AgentTools entry={entry} uses={model.tools} />
									</span>
								</td>
								<td />
								<td />
								<td>{toRun.length === 0 ? null : <wa-button size="small" appearance="plain" aria-label={`Run ${name}`} onClick={() => { onRun(toRun); }}>Run</wa-button>}</td>
							</tr>,
							...files.flatMap((file) => {
								const runs = runsOf.get(file) ?? [];
								const last = runs.at(-1);
								const kind = model.kinds.get(file) ?? "not a test";
								const block = blockOf(kind, contentions.get(file));
								const typical = median(runs.filter(passed).map((run) => run.ms));
								const slower = new Map((last?.tests ?? []).flatMap((test) => {
									const found = test.outcome === "pass" ? slowerOf(runs.slice(0, -1), test.id, test, model.slowerBy) : undefined;

									return found === undefined ? [] : [[test.id, found] as const];
								}));
								const opened = open.has(file);
								const reached = model.reach.get(file);

								return [
									<tr key={file}>
										<td class="fv-test" title={file}>
											<span class="fv-toggle" onClick={() => { const next = new Set(open); if (opened) { next.delete(file); } else { next.add(file); } setOpen(next); }}>{last === undefined ? "  " : opened ? "▾ " : "▸ "}</span>
											<a href="#" onClick={(event) => { event.preventDefault(); onOpen(file); }}>{file.split("/").findLast((part) => part !== "")}</a>
											{model.touched.has(file) ? <wa-badge variant="warning" title="Code it ran has changed since it last ran."> touched</wa-badge> : null}
										</td>
										<td title={KIND_TITLE[kind]}>{kind}</td>
										<td>{block === undefined ? null : <wa-badge variant="danger" title={block.title}>{block.said}</wa-badge>}</td>
										<td><Effects effects={last?.effects} before={runs.at(-2)?.effects} /></td>
										<td title="Lines of code it ran, and how many no other test file runs.">
											{reached === undefined || reached.lines === 0 ? null : reached.only > 0 ? `${String(reached.lines)} lines · ${String(reached.only)} only here` : <span class="wa-cluster wa-gap-3xs">{`${String(reached.lines)} lines`}<wa-badge appearance="outlined" variant="neutral">nothing only here</wa-badge></span>}
										</td>
										<td><When run={lastWhere(runs, true)} /></td>
										<td><When run={lastWhere(runs, false)} /></td>
										<td>
											{last === undefined
												? <span class="wa-caption-s">not run</span>
												: (
														<span class="wa-cluster wa-gap-3xs">
															{lasted(typical)}
															{slower.size === 0 ? null : <wa-badge variant="warning" appearance="outlined" title={[...slower.keys()].map((id) => id.split(" › ").slice(1).join(" › ")).join("\n")}>{`${String(slower.size)} slower`}</wa-badge>}
														</span>
													)}
										</td>
										<td><Ci standings={model.ci.byFile.get(file)} /></td>
										<td>{running.has(file) ? <wa-spinner /> : runnable(file) ? <wa-button size="small" appearance="plain" aria-label={`Run ${file}`} onClick={() => { onRun([file]); }}>Run</wa-button> : null}</td>
									</tr>,
									...opened && last?.output !== undefined ? [<tr key={`${file} output`}><td class="fv-case" colSpan={10}>{last.output}</td></tr>] : [],
									...opened ? (last?.tests ?? []).map((test) => (
										<tr key={test.id} title={test.error}>
											<td class="fv-case">{test.id.split(" › ").slice(1).join(" › ")}</td>
											<td>{test.outcome === "pass" ? null : <wa-badge variant="danger">{test.outcome}</wa-badge>}</td>
											<td>{(contentions.get(file) ?? []).filter((each) => each.test === test.id).map((each) => <wa-badge key={`${each.resource} ${each.other}`} variant="danger" appearance="outlined" title={saidOf(each)}>{`${each.touches} ${each.resource}`}</wa-badge>)}</td>
											<td><Effects effects={test.effects} before={runs.at(-2)?.tests.find((each) => each.id === test.id)?.effects} /></td>
											<td colSpan={3} />
											<td>
												<span class="wa-cluster wa-gap-3xs">
													{lasted(test.ms)}
													{slower.has(test.id) ? <SlowerBadge slower={slower.get(test.id) as Slower} /> : null}
												</span>
											</td>
											<td />
											<td />
										</tr>
									)) : []
								];
							})
						];
					})}
				</tbody>
			</table>
		</div>
	);
}

export function installFeaturesView(vscode: typeof vscodeApi, hub: Hub, log: Logger): void {
	const rpc = createRpcClient(hub);
	const ledgerUri = vscode.Uri.file(`${ROOT}/${ledgerPath()}`);
	const approved: string[] = [];
	const running = new Set<string>();
	let model: Model = { "features": [], "files": new Map(), "kinds": new Map(), "history": [], "reach": new Map(), "touched": new Set(), "unchecked": { "not run": [], "lines not run": [], "config": [] }, "slowerBy": 25, "titles": new Map(), "ci": { "byFile": new Map(), "runs": 0 }, "coverage": new Map(), "capabilities": new Map() };
	const redraws = new Set<() => void>();
	const redraw = (): void => {
		for (const each of redraws) {
			each();
		}
	};

	const textOf = async (uri: vscodeApi.Uri): Promise<string | undefined> => Promise.resolve(vscode.workspace.fs.readFile(uri)).then((bytes) => new TextDecoder().decode(bytes), () => undefined);

	const filesIn = async (entry: string): Promise<string[]> => {
		const uri = vscode.Uri.file(`${ROOT}/${entry}`);
		const type = await Promise.resolve(vscode.workspace.fs.stat(uri)).then((stat) => stat.type, () => undefined);

		if (type !== vscode.FileType.Directory) {
			return [entry];
		}

		return (await vscode.workspace.findFiles(new vscode.RelativePattern(uri, "**/*"), "**/node_modules/**")).map((each) => vscode.workspace.asRelativePath(each, false)).filter((path) => isTestFile(path)).toSorted((one, other) => one.localeCompare(other));
	};

	let standings: TestStanding[] = [];
	const joined = (ofCi: TestStanding[]): Map<string, TestStanding[]> => {
		const byFile = new Map<string, TestStanding[]>();

		for (const standing of ofCi) {
			const file = fileOf(standing, model.titles);

			if (file !== undefined) {
				byFile.set(file, [...byFile.get(file) ?? [], standing]);
			}
		}

		return byFile;
	};

	const read = async (): Promise<void> => log.span("editor.workbench.features-view.read", { "path": ledgerPath() }, async (span) => {
		const ledger = parseLedger(await textOf(ledgerUri));
		const features = Object.entries(ledger).toSorted(([one], [other]) => one.localeCompare(other));
		const files = new Map(await Promise.all(features.map(async ([name, entry]): Promise<[string, string[]]> => [name, [...new Set((await Promise.all((entry.tests ?? []).map(filesIn))).flat())]])));
		const texts = new Map(await Promise.all([...new Set([...files.values()].flat())].map(async (file): Promise<[string, string]> => [file, await textOf(vscode.Uri.file(`${ROOT}/${file}`)) ?? ""])));
		const kinds = new Map([...texts].map(([file, text]): [string, Kind] => [file, kindOf(text)]));
		const { history } = await rpc.request("tests.history", {}, { "timeoutMs": 60_000, "waitForResponderMs": 60_000 }) as { "history": RunRecord[] };

		const { reach } = await rpc.request("tests.reach", {}, { "timeoutMs": 60_000 }) as { "reach": Record<string, Record<string, [number, number][]>> };
		const { coverage } = await rpc.request("tests.coverage", {}, { "timeoutMs": 60_000 }) as { "coverage": Record<string, { "statements": number; "ran": number; "by"?: string[] }> };
		const code = (await vscode.workspace.findFiles("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}", "**/node_modules/**")).map((uri) => vscode.workspace.asRelativePath(uri, false)).filter((path) => isOwnedCode(path) && !isTestFile(path));
		const { "capabilities": canOf, "read": capabilitiesRead } = await capabilitiesOf(vscode, ROOT, code);
		const { "tests": affected, why } = await rpc.request("tests.affected", { "glance": true }, { "timeoutMs": 60_000 }) as { "tests": { "file": string; "stale": boolean }[]; "why": { "path": string; "why": Why }[] };
		const changesThat = (reason: Why): string[] => why.filter((each) => each.why === reason).map((each) => each.path);

		const tools = await rpc.request("agent.tools", undefined, { "timeoutMs": 5000, "waitForResponderMs": 1500 }).then((answer) => answer as ToolUses, () => undefined);

		model = { "features": features, "files": files, "kinds": kinds, "history": history, "reach": reachOf(reach), "touched": new Set(affected.filter((test) => test.stale).map((test) => test.file)), "unchecked": { "not run": changesThat("not run"), "lines not run": changesThat("lines not run"), "config": changesThat("config") }, "slowerBy": vscode.workspace.getConfiguration("run.tests").get<number>("slowerBy", 25), "titles": new Map([...texts].map(([file, text]) => [file, titlesOf(text)])), "ci": model.ci, "coverage": coverageByFeature(ledger, code, coverage, featuresOfTests(files)), "capabilities": capabilitiesByFeature(ledger, canOf, history, files), ...tools === undefined ? {} : { "tools": tools } };
		model.ci = { ...model.ci, "byFile": joined(standings) };
		span.end({ "count": features.length, "tests": kinds.size, "runs": history.length, "files": code.length, "read": capabilitiesRead, "toolUses": tools?.tools.length ?? -1 });
		redraw();
	});

	const readCi = async (): Promise<void> => {
		const answer = await rpc.request("ci.outcomes", {}, { "timeoutMs": 300_000, "waitForResponderMs": 60_000 }).catch((error: unknown) => ({ "standings": [], "runs": 0, "refused": error instanceof Error ? error.message : String(error) })) as { "standings": TestStanding[]; "runs": number; "refused"?: string };

		standings = answer.standings;
		model = { ...model, "ci": { "byFile": joined(standings), "runs": answer.runs, ...answer.refused === undefined ? {} : { "refused": answer.refused } } };
		redraw();
	};

	const run = async (files: string[]): Promise<void> => log.span("editor.workbench.features-view.run", { "count": files.length }, async (span) => {
		for (const file of files) {
			running.add(file);
		}

		redraw();

		try {
			let answer = await rpc.request("tests.run", { "files": files, "approved": approved }, { "timeoutMs": 120_000, "waitForResponderMs": 60_000 }) as Answer;

			for (;;) {
				if (answer.ask !== undefined) {
					if (await vscode.window.showWarningMessage(answer.ask.message, "Allow") !== "Allow") {
						break;
					}

					approved.push(answer.ask.key);
					answer = await rpc.request("tests.run", { "run": answer.run, "approved": approved }, { "timeoutMs": 120_000 }) as Answer;
				} else if (answer.running === undefined) {
					break;
				} else {
					answer = await rpc.request("tests.run", { "run": answer.run }, { "timeoutMs": 120_000 }) as Answer;
				}
			}
		} finally {
			for (const file of files) {
				running.delete(file);
			}

			redraw();
			span.end({ "count": files.length });
		}
	});

	function View(): JSX.Element {
		const [, drawn] = useState(0);

		useEffect(() => {
			const again = (): void => { drawn((count) => count + 1); };

			redraws.add(again);
			again();

			return () => { redraws.delete(again); };
		}, []);

		return <Table model={model} running={running} onRun={(files) => { void run(files); }} onOpen={(file) => { void vscode.window.showTextDocument(vscode.Uri.file(`${ROOT}/${file}`)); }} />;
	}

	registerCustomView({
		"id": "editor.features",
		"name": "Features and Tests",
		"location": ViewContainerLocation.Panel,
		"renderBody": (container: HTMLElement) => {
			featuresViewStyles();
			render(<View />, container);

			return { "dispose": () => { render(null, container); } };
		}
	});

	vscode.commands.registerCommand("editor.features.show", async () => {
		await vscode.commands.executeCommand("editor.features.focus");
		await read();
		void readCi();
	});

	vscode.workspace.onDidSaveTextDocument(() => {
		void read();
	});

	hub.subscribe("tests.kept", () => {
		void read();
	});

	vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration("run.tests.slowerBy")) {
			void read();
		}
	});

	const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(ROOT), ledgerPath()));

	for (const event of [watcher.onDidChange, watcher.onDidCreate, watcher.onDidDelete]) {
		event(() => {
			void read();
		});
	}

	void read().then(readCi);
}
