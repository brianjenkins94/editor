/**
 * Capabilities — extension host entry (plain CJS, loads in the web-worker host that can't load ESM entrypoints:
 * CodinGame/monaco-vscode-api#818). Responsibilities:
 *
 * 1. The tsserver plugin (ts-plugin.js) runs BOTH analysis halves inside tsserver — static (util/silo) + the tsval
 *    canary, reusing tsserver's own `ts` — and publishes NATIVE ts.Diagnostics (source "capabilities"): squiggles
 *    + Problems + hover, with the concrete runtime value merged in once the canary's background run completes.
 *    (Do NOT add a timer-based `restartTsServer` — it races the initial `updateOpen` and hangs "Analyzing…".)
 *
 * 2. The "Capability calls" panel — the middle AND third columns — is rendered HERE. It reads those diagnostics
 *    back (`vscode.languages.getDiagnostics`, source "capabilities") for the resource each call reaches (columns 1
 *    & 2: code + resolved value), and overlays the DISPOSITION (column 3) from the base `.silo/policy.json`
 *    contract: allow / deny, or a computed `review` for an undecided dangerous call. Clicking a row edits the
 *    disposition; a view badge counts the calls still needing attention. No canary code runs in the ext host.
 *
 * 3. The TRIPWIRE (M0 = surface): a `deny`d call the code reaches gets its own ERROR squiggle (a separate
 *    `capabilities-policy` diagnostic collection). Runtime blocking/substituting is the next layer, at real-run.
 */
import * as vscode from "vscode";

import { type Disposition, type Effective, type Policy, effectiveDisposition, policyUri, readPolicy, withRule, withoutRule, writePolicy } from "./policy";
import { type StaticEntry, type StaticSurface, loadStaticSurface, writeStaticSurface } from "./silo-store";

interface Row {
	"capability": string;
	"callee": string;
	"resource": string;
	"resolved": boolean;
	"dangerous": boolean;
	"disposition": Effective;
	"range": vscode.Range;
}

/** Parse the plugin's message "capability: callee → value (ran) · type" → parts, with a CLEAN resource (the
 *  "(ran)" marker and the unresolved/no-string placeholders stripped) so it can key a policy rule. */
function parseMessage(message: string): { "capability": string; "callee": string; "resource": string; "resolved": boolean } {
	const arrow = message.indexOf(" → ");
	const head = arrow === -1 ? message : message.slice(0, arrow);
	let value = arrow === -1 ? "" : message.slice(arrow + 3);
	const typeSep = value.indexOf(" · ");

	if (typeSep !== -1) {
		value = value.slice(0, typeSep);
	}

	value = value.replace(/ \(ran\)$/u, ""); // the runtime marker isn't part of the resource

	const resolved = value !== "" && !value.startsWith("(");
	const colon = head.indexOf(": ");

	return {
		"capability": colon === -1 ? "" : head.slice(0, colon),
		"callee": colon === -1 ? head : head.slice(colon + 2),
		"resource": resolved ? value : "",
		"resolved": resolved
	};
}

const ICON: Record<Effective, vscode.ThemeIcon> = {
	"allow": new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed")),
	"deny": new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("list.errorForeground")),
	"review": new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"))
};

export function activate(context: vscode.ExtensionContext): void {
	let rows: Row[] = [];
	const changed = new vscode.EventEmitter<void>();

	const provider: vscode.TreeDataProvider<Row> = {
		"onDidChangeTreeData": changed.event,
		"getChildren": (element) => (element === undefined ? rows : []),
		"getTreeItem": (row) => {
			const item = new vscode.TreeItem(row.callee, vscode.TreeItemCollapsibleState.None);

			item.description = `${row.disposition} · ${row.capability} → ${row.resolved ? row.resource : "(unresolved)"}`;
			item.iconPath = ICON[row.disposition];
			item.tooltip = new vscode.MarkdownString([
				`**${row.capability}** · disposition: **${row.disposition}**${row.dangerous ? " · ⚠ dangerous" : ""}`,
				"",
				`- callee: \`${row.callee}\``,
				`- resource: ${row.resolved ? "`" + row.resource + "`" : "_unresolved (needs a run / a literal)_"}`
			].join("\n"));
			// Only a resolved resource can be dispositioned (you can't allow what you can't see) — the inline +
			// context menus key off this contextValue; clicking the row itself opens the same disposition QuickPick.
			item.contextValue = row.resolved ? "capabilityCall.resolved" : "capabilityCall.unresolved";
			item.command = { "command": "capabilities.disposition", "title": "Disposition…", "arguments": [row] };

			return item;
		}
	};

	const view = vscode.window.createTreeView("capabilities.calls", { "treeDataProvider": provider });

	// The TRIPWIRE (M0 = surface): a `deny`d capability call the code reaches gets an ERROR squiggle + Problems
	// entry — "you said no, but the code does this". Extension-owned (no plugin change, no cross-context policy
	// sync). Runtime BLOCKING/substituting a denied or mocked call happens where real effects do (preview/runtime)
	// and is the next layer. `capabilities-policy` is a separate source from the plugin's `capabilities`.
	const violations = vscode.languages.createDiagnosticCollection("capabilities-policy");
	// A stable digest of what we last published, so re-publishing identical violations (our own `set` re-fires
	// onDidChangeDiagnostics → refresh → updateViolations) short-circuits instead of looping.
	let lastViolationsKey = "";

		// The STATIC capability surface (.silo/capabilities.json): what analysis says each file CAN reach, built from
		// the same "capabilities" diagnostics. Merged across the session — tsserver only analyzes OPEN files, so this
		// fills in as you browse (a whole-project sweep is a later engine change); the ACTIVE file is updated
		// authoritatively (including removals) since we know it was just analyzed. Digest-guarded so the committed
		// file is written only on real DRIFT (a file gaining/losing a capability), not on every diagnostics refresh.
		let staticSurface: StaticSurface | undefined;
		let lastStaticKey = "";

	context.subscriptions.push(view, violations);

	let policy: Policy = { "version": 1, "rules": [] };

	/** Re-derive deny-violations across every file with capability diagnostics; publish only when they changed. */
	const updateViolations = (): void => {
		const next = new Map<string, vscode.Diagnostic[]>();

		for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
			const denied: vscode.Diagnostic[] = [];

			for (const diagnostic of diagnostics) {
				if (diagnostic.source !== "capabilities") {
					continue;
				}

				const parsed = parseMessage(diagnostic.message);
				const dangerous = diagnostic.severity === vscode.DiagnosticSeverity.Warning;

				if (parsed.resolved && effectiveDisposition(policy, parsed.capability, parsed.resource, dangerous) === "deny") {
					const violation = new vscode.Diagnostic(diagnostic.range, `${parsed.capability} call to "${parsed.resource}" is denied by capability policy`, vscode.DiagnosticSeverity.Error);

					violation.source = "capabilities-policy";
					denied.push(violation);
				}
			}

			if (denied.length > 0) {
				next.set(uri.toString(), denied);
			}
		}

		const key = [...next.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([uri, list]) => uri + "#" + list.map((diagnostic) => `${diagnostic.range.start.line}:${diagnostic.range.start.character}`).join(",")).join("|");

		if (key === lastViolationsKey) {
			return; // nothing changed — don't re-publish (avoids the onDidChangeDiagnostics feedback loop)
		}

		lastViolationsKey = key;
		violations.clear();
		for (const [uri, list] of next) {
			violations.set(vscode.Uri.parse(uri), list);
		}
	};

	/** Rebuild the STATIC surface from the current "capabilities" diagnostics and persist it (digest-guarded). */
	const updateStaticSurface = async (): Promise<void> => {
		if (staticSurface === undefined) {
			staticSurface = await loadStaticSurface();
		}

		const byFile = new Map<string, StaticEntry[]>();

		for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
			const seen = new Set<string>();
			const entries: StaticEntry[] = [];

			for (const diagnostic of diagnostics) {
				if (diagnostic.source !== "capabilities") {
					continue;
				}

				const parsed = parseMessage(diagnostic.message);

				if (parsed.capability === "") {
					continue;
				}

				const dedupe = `${parsed.capability} ${parsed.callee} ${parsed.resource}`;

				if (!seen.has(dedupe)) {
					seen.add(dedupe);
					entries.push({ "capability": parsed.capability, "callee": parsed.callee, "resource": parsed.resource });
				}
			}

			if (entries.length > 0) {
				byFile.set(vscode.workspace.asRelativePath(uri, false), entries);
			}
		}

		// Set every file we saw caps for. The ACTIVE file additionally gets authoritative removal — it was just
		// analyzed, so zero caps means its calls are genuinely gone (other closed files are left as-is: merge).
		for (const [path, entries] of byFile) {
			staticSurface.capabilities[path] = entries;
		}

		const activeUri = vscode.window.activeTextEditor?.document.uri;

		if (activeUri !== undefined) {
			const activePath = vscode.workspace.asRelativePath(activeUri, false);

			if (!byFile.has(activePath)) {
				delete staticSurface.capabilities[activePath];
			}
		}

		const key = JSON.stringify(Object.entries(staticSurface.capabilities).sort(([a], [b]) => a.localeCompare(b)));

		if (key === lastStaticKey) {
			return; // no drift → don't rewrite (also breaks the onDidChangeDiagnostics feedback loop)
		}

		lastStaticKey = key;
		await writeStaticSurface(staticSurface);
	};

	const refresh = async (): Promise<void> => {
		policy = await readPolicy(policyUri());

		const editor = vscode.window.activeTextEditor;
		const diagnostics = editor === undefined ? [] : vscode.languages.getDiagnostics(editor.document.uri).filter((diagnostic) => diagnostic.source === "capabilities");

		rows = diagnostics.map((diagnostic) => {
			const parsed = parseMessage(diagnostic.message);
			const dangerous = diagnostic.severity === vscode.DiagnosticSeverity.Warning;

			return {
				"capability": parsed.capability,
				"callee": parsed.callee,
				"resource": parsed.resource,
				"resolved": parsed.resolved,
				"dangerous": dangerous,
				"disposition": effectiveDisposition(policy, parsed.capability, parsed.resource, dangerous),
				"range": diagnostic.range
			};
		});

		// Badge = calls still needing attention (undecided-dangerous or explicitly denied).
		const attention = rows.filter((row) => row.disposition !== "allow").length;

		view.badge = attention === 0 ? undefined : { "value": attention, "tooltip": `${attention} capabilit${attention === 1 ? "y" : "ies"} to review` };
		changed.fire();
		updateViolations();
		void updateStaticSurface();
	};

	/** Apply a disposition edit to the policy file, then refresh. */
	const setDisposition = async (row: Row | undefined, disposition: Disposition | "clear"): Promise<void> => {
		const uri = policyUri();

		if (uri === undefined || row === undefined || !row.resolved) {
			return;
		}

		const current = await readPolicy(uri);
		const next = disposition === "clear" ? withoutRule(current, row.capability, row.resource) : withRule(current, row.capability, row.resource, disposition);

		await writePolicy(uri, next);
		await refresh();
	};

	/** Reveal the call in the editor. */
	const reveal = async (row: Row): Promise<void> => {
		const uri = vscode.window.activeTextEditor?.document.uri;

		if (uri !== undefined) {
			await vscode.commands.executeCommand("vscode.open", uri, { "selection": row.range });
		}
	};

	/** Row click → a QuickPick of dispositions (+ reveal). A convenience alongside the inline/context-menu icons
	 *  (package.json) — those DO render and work here (view/item/context is wired for a dynamically-registered
	 *  extension); the QuickPick is just a bigger click target than a ~16px hover icon. */
	const disposition = async (row?: Row): Promise<void> => {
		if (row === undefined) {
			return;
		}

		if (!row.resolved) {
			await reveal(row); // nothing to disposition on an unresolved resource
			await vscode.window.showInformationMessage("This capability's resource is unresolved — it needs a run or a literal before it can be allowed/denied.");

			return;
		}

		const pick = await vscode.window.showQuickPick(
			[
				{ "label": "$(pass) Allow", "value": "allow" },
				{ "label": "$(circle-slash) Deny", "value": "deny" },
				{ "label": "$(discard) Clear (use default)", "value": "clear" },
				{ "label": "$(go-to-file) Reveal in editor", "value": "reveal" }
			],
			{ "title": `${row.capability} → ${row.resource}`, "placeHolder": `Currently: ${row.disposition}` }
		);

		if (pick === undefined) {
			return;
		}

		if (pick.value === "reveal") {
			await reveal(row);
		} else {
			await setDisposition(row, pick.value as Disposition | "clear");
		}
	};

	context.subscriptions.push(
		vscode.commands.registerCommand("capabilities.disposition", (row?: Row) => disposition(row)),
		vscode.commands.registerCommand("capabilities.allow", (row?: Row) => setDisposition(row, "allow")),
		vscode.commands.registerCommand("capabilities.deny", (row?: Row) => setDisposition(row, "deny")),
		vscode.commands.registerCommand("capabilities.clear", (row?: Row) => setDisposition(row, "clear")),
		// The plugin re-publishes (with runtime values) after the canary's async run → onDidChangeDiagnostics fires.
		vscode.languages.onDidChangeDiagnostics((event) => {
			const uri = vscode.window.activeTextEditor?.document.uri;

			if (uri !== undefined && event.uris.some((changedUri) => changedUri.toString() === uri.toString())) {
				void refresh();
			}
		}),
		vscode.window.onDidChangeActiveTextEditor(() => { void refresh(); })
	);

	// Hand-edits to the base policy file re-render the panel too.
	const watcher = vscode.workspace.createFileSystemWatcher("**/.silo/policy.json");

	context.subscriptions.push(
		watcher,
		watcher.onDidChange(() => { void refresh(); }),
		watcher.onDidCreate(() => { void refresh(); }),
		watcher.onDidDelete(() => { void refresh(); })
	);

	void refresh();
}

export function deactivate(): void { /* subscriptions disposed by the host */ }
