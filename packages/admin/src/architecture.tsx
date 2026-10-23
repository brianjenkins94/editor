/**
 * The architecture page (packages/api/README.md, "The architecture page"): the system drawn from its code, live. Two halves, each from what's authoritative for
 * it: the deployment as its wrangler configs say (`virtual:deployment`, read when this app is built: the Workers, their
 * hosts, bindings, crons and redirects), and the API as it runs (GET /admin/architecture: its routes, its stores' tables
 * with their row counts, what it relays and who may call it). Traffic's last hour (GET /admin/traffic) puts requests on
 * the hosts and Workers, when the viewer may read it. Zero-knowledge: names from the code, and counts.
 *
 * Its own renderer, not the editor's: five columns (calls in, hosts, Workers, what they keep, calls out), each a stack
 * of boxes, and curves between them. Click a box to follow its connections.
 */
import type { ComponentChildren } from "preact";
import type { Worker } from "../deployment";
import deployment from "virtual:deployment";
import { useEffect, useState } from "preact/hooks";
import { get } from "./session";

/** What the API says about itself (packages/api/src/architecture.ts). */
interface Described {
	"environment": string;
	"origin": string;
	"routes": { "method": string; "path": string }[];
	"database": { "table": string; "rows": number }[];
	"objects": { "binding": string; "class": string; "tables": string[]; "live"?: number }[];
	"proxied": { "base": "api" | "git"; "call": string }[];
	"clients": string[];
	"calls": { "github": { "web": string; "api": string }; "analytics": boolean; "alerts": string | null };
}

/** The last hour of Cloudflare's analytics, as much of /admin/traffic as the page uses. */
interface Traffic {
	"byHost": { "host": string; "requests": number }[];
	"workers": { "script": string; "requests": number; "errors": number }[];
}

interface Node { "id": string; "column": number; "title": string; "kind": string; "lines": string[]; "metric"?: string }

interface Edge { "from": string; "to": string; "label"?: string; "back"?: boolean }

const COLUMNS = ["Calls in", "Hosts", "Workers", "What they keep", "Calls out"];

const compact = (value: number): string => (value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value));

const hostOf = (url: string): string => new URL(url).host;

/** The API's routes by their first segment: `auth · 6`. */
function groups(routes: Described["routes"]): string[] {
	const counted = new Map<string, number>();

	for (const route of routes) {
		const group = `/${route.path.split("/")[1] ?? ""}`;

		counted.set(group, (counted.get(group) ?? 0) + 1);
	}

	return [...counted].map(([group, count]) => `${group} · ${count} route${count === 1 ? "" : "s"}`);
}

/** The system as nodes and edges: the deployment for this environment, the API's own description, and the traffic. */
function model(workers: Worker[], described: Described, traffic: Traffic | undefined): { "nodes": Node[]; "edges": Edge[] } {
	const nodes: Node[] = [];
	const edges: Edge[] = [];
	const hosted = (host: string): string | undefined => {
		const requests = traffic?.byHost.filter((row) => row.host === host).reduce((sum, row) => sum + row.requests, 0);

		return requests === undefined ? undefined : `${compact(requests)} requests in the last hour`;
	};
	const api = workers.find((worker) => worker.main !== undefined);
	const apiHosts = api === undefined || api.hosts.length === 0 ? [hostOf(described.origin)] : api.hosts;

	// Calls in: our apps, from their origins, and everyone else.
	for (const client of described.clients) {
		nodes.push({ "id": `client:${client}`, "column": 0, "title": hostOf(client), "kind": "an app, in a browser", "lines": [] });

		for (const host of apiHosts) {
			edges.push({ "from": `client:${client}`, "to": `host:${host}`, "label": "DPoP" });
		}
	}

	nodes.push({ "id": "anyone", "column": 0, "title": "Anyone", "kind": "visitors, crawlers, scanners", "lines": [] });

	// Hosts and Workers, from the configs (the API's own origin where it has no custom domain).
	for (const worker of workers) {
		const hosts = worker === api ? apiHosts : worker.hosts;
		const counted = traffic?.workers.find((row) => row.script === worker.name);
		const lines = worker === api ? groups(described.routes) : [`static assets: ${worker.assets ?? "none"}`, ...worker.redirects.map((host) => `redirects to ${host}`)];

		nodes.push({ "id": `worker:${worker.name}`, "column": 2, "title": worker.name, "kind": worker.main === undefined ? "Worker, static assets only" : `Worker, ${worker.main}`, "lines": [...lines, ...worker.crons.map((cron) => `cron ${cron}`)], ...counted === undefined ? {} : { "metric": `${compact(counted.requests)} requests, ${compact(counted.errors)} errors` } });

		for (const host of hosts) {
			const metric = hosted(host);

			if (!nodes.some((node) => node.id === `host:${host}`)) {
				nodes.push({ "id": `host:${host}`, "column": 1, "title": host, "kind": worker.hosts.includes(host) ? "custom domain" : "origin", "lines": [], ...metric === undefined ? {} : { "metric": metric } });
				edges.push({ "from": "anyone", "to": `host:${host}` });
			}

			edges.push({ "from": `host:${host}`, "to": `worker:${worker.name}` });
		}

		for (const target of worker.redirects) {
			edges.push({ "from": `worker:${worker.name}`, "to": `host:${target}`, "label": "redirects", "back": true });
		}

		// An app loads from its own host.
		for (const client of described.clients.filter((origin) => hosts.includes(hostOf(origin)) && worker !== api)) {
			edges.push({ "from": `client:${client}`, "to": `host:${hostOf(client)}`, "label": "loads" });
		}
	}

	if (api === undefined) {
		return { "nodes": nodes, "edges": edges };
	}

	// What the API keeps: its Durable Objects (their tables from their code), D1 (its tables, counted), R2, its limits.
	for (const object of described.objects) {
		nodes.push({ "id": `object:${object.class}`, "column": 3, "title": object.class, "kind": `Durable Object, ${object.binding}`, "lines": object.tables, ...object.live === undefined ? {} : { "metric": `${compact(object.live)} live` } });
	}

	for (const database of api.databases) {
		nodes.push({ "id": `d1:${database.name}`, "column": 3, "title": database.name, "kind": `D1, ${database.binding}`, "lines": described.database.map((table) => `${table.table} · ${compact(table.rows)}`) });
	}

	for (const bucket of api.buckets) {
		nodes.push({ "id": `r2:${bucket.name}`, "column": 3, "title": bucket.name, "kind": `R2, ${bucket.binding}`, "lines": ["each audit row, write-once"] });
	}

	if (api.rateLimits.length > 0) {
		nodes.push({ "id": "limits", "column": 3, "title": "Rate limits", "kind": "Workers rate limiting", "lines": api.rateLimits.map((limit) => `${limit.binding} · ${limit.limit}/${limit.period}s`) });
	}

	for (const node of nodes.filter((candidate) => candidate.column === 3)) {
		edges.push({ "from": `worker:${api.name}`, "to": node.id });
	}

	// What it calls.
	const github = described.proxied.filter((call) => call.base === "api").length;
	const outside: Node[] = [
		{ "id": "github:web", "column": 4, "title": hostOf(described.calls.github.web), "kind": "GitHub: sign-in, git", "lines": ["the OAuth exchange", `${described.proxied.length - github} git calls relayed`] },
		{ "id": "github:api", "column": 4, "title": hostOf(described.calls.github.api), "kind": "GitHub's API", "lines": [`${github} calls relayed, no others`] },
		...described.calls.analytics ? [{ "id": "cloudflare", "column": 4, "title": "api.cloudflare.com", "kind": "Cloudflare's analytics", "lines": ["read-only, for Traffic"] }] : [],
		...described.calls.alerts === null ? [] : [{ "id": "alerts", "column": 4, "title": described.calls.alerts, "kind": "alerts", "lines": ["what looks like abuse, at once"] }]
	];

	for (const node of outside) {
		nodes.push(node);
		edges.push({ "from": `worker:${api.name}`, "to": node.id });
	}

	return { "nodes": nodes, "edges": edges };
}

// ── The renderer ───────────────────────────────────────────────────────────────────────────────────────────────────

const WIDTH = 216;
const GAP = 64;
const LINE = 17;
const HEAD = 42;
const TOP = 36;

/** About how many characters fit across a box, in its small monospace lines and its title. */
const FITS = { "line": 29, "title": 25 };

/** Cut to what fits, with an ellipsis; the whole of it is the box's tooltip. */
const fit = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** Where each box goes: its column's x, stacked down the column. */
function layout(nodes: Node[]): { "boxes": Map<string, { "x": number; "y": number; "height": number }>; "height": number } {
	const boxes = new Map<string, { "x": number; "y": number; "height": number }>();
	const bottoms = COLUMNS.map(() => TOP);

	for (const node of nodes) {
		const height = HEAD + (node.lines.length + (node.metric === undefined ? 0 : 1)) * LINE + 8;
		const y = bottoms[node.column] as number;

		boxes.set(node.id, { "x": node.column * (WIDTH + GAP), "y": y, "height": height });
		bottoms[node.column] = y + height + 14;
	}

	return { "boxes": boxes, "height": Math.max(...bottoms) };
}

function Diagram({ nodes, edges }: { "nodes": Node[]; "edges": Edge[] }) {
	const [selected, setSelected] = useState<string | undefined>();
	const { boxes, height } = layout(nodes);
	const near = (edge: Edge): boolean => selected === undefined || edge.from === selected || edge.to === selected;

	return (
		<div class="diagram">
			<svg width={COLUMNS.length * (WIDTH + GAP) - GAP} height={height} role="img" aria-label="The system's architecture">
				{COLUMNS.map((column, index) => <text key={column} class="column" x={index * (WIDTH + GAP)} y={16}>{column}</text>)}
				{edges.map((edge) => {
					const from = boxes.get(edge.from);
					const to = boxes.get(edge.to);

					if (from === undefined || to === undefined) {
						return null;
					}

					const [x1, y1, x2, y2] = edge.back === true ? [from.x, from.y + from.height / 2, to.x + WIDTH, to.y + to.height / 2] : [from.x + WIDTH, from.y + from.height / 2, to.x, to.y + to.height / 2];
					const bend = edge.back === true ? -GAP : GAP / 2;

					return (
						<g key={`${edge.from}→${edge.to}`} class={`edge${near(edge) ? "" : " faded"}${edge.back === true ? " back" : ""}`}>
							<path d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`} />
							{edge.label !== undefined && selected !== undefined && near(edge) && <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 4}>{edge.label}</text>}
						</g>
					);
				})}
				{nodes.map((node) => {
					const box = boxes.get(node.id) as { "x": number; "y": number; "height": number };

					return (
						<g
							key={node.id}
							class={`box${selected === node.id ? " selected" : ""}`}
							transform={`translate(${box.x} ${box.y})`}
							onClick={() => {
								setSelected(selected === node.id ? undefined : node.id);
							}}
						>
							<title>{[node.title, node.kind, ...node.lines, node.metric].filter((part) => part !== undefined).join("\n")}</title>
							<rect width={WIDTH} height={box.height} rx={8} />
							<text class="title" x={12} y={20}>{fit(node.title, FITS.title)}</text>
							<text class="kind" x={12} y={35}>{node.kind}</text>
							{node.lines.map((line, index) => <text key={line} class="line" x={12} y={HEAD + 12 + index * LINE}>{fit(line, FITS.line)}</text>)}
							{node.metric !== undefined && <text class="metric" x={12} y={HEAD + 12 + node.lines.length * LINE}>{node.metric}</text>}
						</g>
					);
				})}
			</svg>
		</div>
	);
}

// ── The page ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Read again every minute, so the counts stay live. */
const EVERY = 60_000;

function Section({ title, children }: { "title": string; "children": ComponentChildren }) {
	return (
		<div class="wa-stack wa-gap-s">
			<h2 class="wa-heading-l">{title}</h2>
			{children}
		</div>
	);
}

/** `query`: in development, `as=production` (or `dev`) draws that environment's deployment around the local API's
 *  description, to see its layout without signing in there. */
export function ArchitecturePage({ query }: { "query": URLSearchParams }) {
	const [described, setDescribed] = useState<Described | undefined>();
	const [traffic, setTraffic] = useState<Traffic | undefined>();
	const [problem, setProblem] = useState<string | undefined>();
	const [at, setAt] = useState<number | undefined>();

	useEffect(() => {
		const read = (): void => {
			get<Described>("/architecture").then((answer) => {
				setDescribed(answer);
				setAt(Date.now());
			}, (error: unknown) => {
				setProblem(error instanceof Error && / 403$/u.test(error.message) ? "Your roles don't include this." : "Couldn't load this.");
			});
			// Traffic is a second permission: without it, the diagram has no request counts.
			get<Traffic>("/traffic?window=1h").then(setTraffic, () => undefined);
		};
		const timer = setInterval(read, EVERY);

		read();

		return () => {
			clearInterval(timer);
		};
	}, []);

	if (problem !== undefined) {
		return <wa-callout variant="danger">{problem}</wa-callout>;
	}

	if (described === undefined) {
		return <wa-spinner />;
	}

	const environment = import.meta.env.DEV ? query.get("as") ?? described.environment : described.environment;
	const workers = deployment[environment] ?? [];
	// Cloudflare's analytics are the deployed Workers': a local one shares its name with production's, not its traffic.
	const { nodes, edges } = model(workers, described, environment === "local" ? undefined : traffic);

	return (
		<section class="wa-stack wa-gap-l">
			<h1 class="wa-heading-xl">Architecture</h1>
			<p class="wa-color-text-quiet">
				The <strong>{environment}</strong> system, drawn from its code: the Workers, hosts and bindings from {workers.map((worker) => worker.config).join(", ")}, read when this app was built; the API's routes, stores and tables from the API itself, live ({at === undefined ? "" : new Date(at).toLocaleTimeString()}, every minute). Names and counts only: no one's data. Click a box to follow it.
			</p>
			<Diagram nodes={nodes} edges={edges} />
			<div class="wa-grid wa-gap-l wa-align-items-start pair">
				<Section title={`Routes (${described.routes.length})`}>
					<div class="mono">{described.routes.map((route) => <div key={`${route.method} ${route.path}`}>{route.method} {route.path}</div>)}</div>
				</Section>
				<Section title={`GitHub calls relayed (${described.proxied.length})`}>
					<div class="mono">{described.proxied.map((call) => <div key={`${call.base} ${call.call}`}>{call.base === "git" ? "git " : ""}{call.call}</div>)}</div>
				</Section>
			</div>
		</section>
	);
}
