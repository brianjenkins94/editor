/**
 * Hub against a model of what it promises (see README.md): random trees of hubs — random subscriptions, permissions at
 * either end of each link, non-transit links — checked against a reference router a few lines long, after they're
 * built and after each random change (unsubscribing, subscribing, permit(), unlinking).
 *
 * The reference: a message published on hub H on subject S reaches handler (G, pattern) exactly once if the pattern
 * matches S and every hop of the tree path H → G lets S through — the sending end's `subscribe` allows it, the receiving
 * end's `publish` allows it, and no hub on the way joins two non-transit links — and reaches nothing else. `interested`
 * on H says whether a message on S would reach anything. Failures print the seed: `HUB_MODEL_SEED=<seed>` replays one.
 */
import type { Hub, LinkPermissions } from "../src/index.ts";
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { createHub, pipe } from "../src/index.ts";

// ── The reference ───────────────────────────────────────────────────────────────────────────────────────────────────

/** NATS matching, written out: `*` is one token, `>` one or more, and only last. */
function refMatches(pattern: string, subject: string): boolean {
	const p = pattern.split(".");
	const s = subject.split(".");
	const from = (i: number, j: number): boolean => (i === p.length ? j === s.length : p[i] === ">" ? j < s.length : j < s.length && (p[i] === "*" || p[i] === s[j]) && from(i + 1, j + 1));

	return from(0, 0);
}

const allows = (patterns: string[] | undefined, subject: string): boolean => patterns === undefined || patterns.some((pattern) => refMatches(pattern, subject));

/** One hub's end of a link: its options for it. */
interface End { "transit": boolean; "permissions"?: LinkPermissions }

interface World {
	"hubs": Hub[];
	/** ends[x].get(y): x's end of its link to y. */
	"ends": Map<number, End>[];
	"handlers": { "id": number; "hub": number; "pattern": string; "unsubscribe": () => void }[];
	"unlinks": Map<string, () => void>;
}

/** The hubs from `from` to `to` along the tree, or undefined if they aren't connected. */
function path(world: World, from: number, to: number): number[] | undefined {
	const previous = new Map<number, number>([[from, -1]]);
	const queue = [from];

	while (queue.length > 0) {
		const at = queue.shift()!;

		for (const next of world.ends[at]!.keys()) {
			if (!previous.has(next)) {
				previous.set(next, at);
				queue.push(next);
			}
		}
	}

	if (!previous.has(to)) {
		return undefined;
	}

	const hops = [to];

	while (hops[0] !== from) {
		hops.unshift(previous.get(hops[0]!)!);
	}

	return hops;
}

/** Does a message on `subject` published on hub `from` reach hub `to`? */
function reaches(world: World, from: number, to: number, subject: string): boolean {
	const hops = path(world, from, to);

	return hops !== undefined && hops.every((at, index) => {
		const next = hops[index + 1];
		const previous = hops[index - 1];
		const sends = next === undefined || (allows(world.ends[at]!.get(next)!.permissions?.subscribe, subject) && allows(world.ends[next]!.get(at)!.permissions?.publish, subject));
		const transits = previous === undefined || next === undefined || world.ends[at]!.get(previous)!.transit || world.ends[at]!.get(next)!.transit;

		return sends && transits;
	});
}

function expectedHandlers(world: World, from: number, subject: string): number[] {
	return world.handlers.filter((handler) => refMatches(handler.pattern, subject) && reaches(world, from, handler.hub, subject)).map((handler) => handler.id).sort((a, b) => a - b);
}

// ── Random worlds ───────────────────────────────────────────────────────────────────────────────────────────────────

/** mulberry32: a small seeded PRNG, so a failure replays. */
function rng(seed: number): () => number {
	let state = seed >>> 0;

	return () => {
		state = (state + 0x6d2b79f5) >>> 0;

		let t = state;

		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const SUBJECTS = ["a", "b"].flatMap((x) => [x, ...["a", "b"].flatMap((y) => [`${x}.${y}`, `${x}.${y}.a`, `${x}.${y}.b`])]);

function generators(random: () => number) {
	const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;
	const pattern = (): string => {
		const length = 1 + Math.floor(random() * 3);
		const tokens = Array.from({ "length": length }, () => pick(["a", "b", "*"]));

		if (random() < 0.3) {
			tokens[length - 1] = ">";
		}

		return tokens.join(".");
	};
	const list = (): string[] | undefined => (random() < 0.5 ? undefined : Array.from({ "length": Math.floor(random() * 3) }, pattern));
	const permissions = (): LinkPermissions | undefined => {
		if (random() < 0.6) {
			return undefined;
		}

		const [publish, subscribe] = [list(), list()];

		return { ...publish === undefined ? {} : { "publish": publish }, ...subscribe === undefined ? {} : { "subscribe": subscribe } };
	};

	return { "pick": pick, "pattern": pattern, "permissions": permissions, "transit": (): boolean => random() >= 0.25 };
}

/** Every delivery settles within one macrotask: the pipes deliver on microtasks. */
const settle = async (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

function describe(world: World): string {
	const edges = world.ends.flatMap((ends, x) => [...ends].filter(([y]) => x < y).map(([y, end]) => `h${x}${JSON.stringify(end)} ⇄ h${y}${JSON.stringify(world.ends[y]!.get(x))}`));
	const handlers = world.handlers.map((handler) => `#${handler.id} h${handler.hub} ${handler.pattern}`);

	return `links:\n  ${edges.join("\n  ") || "(none)"}\nhandlers:\n  ${handlers.join("\n  ") || "(none)"}`;
}

async function check(world: World, random: () => number, stage: string, context: () => string): Promise<void> {
	await settle();

	for (const [index, hub] of world.hubs.entries()) {
		for (const subject of SUBJECTS) {
			const expected = expectedHandlers(world, index, subject).length > 0;

			assert.equal(hub.interested(subject), expected, `${stage}: h${index}.interested("${subject}") should be ${expected}\n${context()}`);
		}
	}

	const { pick } = generators(random);

	for (let round = 0; round < 6; round += 1) {
		const from = Math.floor(random() * world.hubs.length);
		const subject = pick(SUBJECTS);

		delivered.length = 0;
		world.hubs[from]!.publish(subject);
		await settle();

		assert.deepEqual([...delivered].sort((a, b) => a - b), expectedHandlers(world, from, subject), `${stage}: h${from} publishing "${subject}" — delivered to handlers (exactly once each)\n${context()}`);
	}
}

const delivered: number[] = [];

async function runWorld(seed: number): Promise<void> {
	const random = rng(seed);
	const gen = generators(random);
	const size = 2 + Math.floor(random() * 5);
	const world: World = { "hubs": [], "ends": [], "handlers": [], "unlinks": new Map() };
	let nextHandler = 0;
	const context = (): string => `seed ${seed}\n${describe(world)}`;
	const subscribe = (hub: number): void => {
		const id = nextHandler;
		const pattern = gen.pattern();

		nextHandler += 1;
		world.handlers.push({ "id": id, "hub": hub, "pattern": pattern, "unsubscribe": world.hubs[hub]!.subscribe(pattern, () => { delivered.push(id); }) });
	};

	for (let index = 0; index < size; index += 1) {
		world.hubs.push(createHub({ "id": "h" + index }));
		world.ends.push(new Map());
	}

	// A random tree: each hub after the first links to one before it.
	for (let child = 1; child < size; child += 1) {
		const parent = Math.floor(random() * child);
		const [up, down] = pipe({ "schedule": (deliver) => { queueMicrotask(deliver); } });
		const childEnd: End = { "transit": gen.transit(), "permissions": gen.permissions() };
		const parentEnd: End = { "transit": gen.transit(), "permissions": gen.permissions() };

		world.ends[child]!.set(parent, childEnd);
		world.ends[parent]!.set(child, parentEnd);

		const unlinkChild = world.hubs[child]!.link(up, childEnd);
		const unlinkParent = world.hubs[parent]!.link(down, parentEnd);

		world.unlinks.set(`${child}|${parent}`, () => { unlinkChild(); unlinkParent(); });
	}

	for (let count = 1 + Math.floor(random() * 6); count > 0; count -= 1) {
		subscribe(Math.floor(random() * size));
	}

	await check(world, random, "built", context);

	// Some handlers go, others come.
	world.handlers = world.handlers.filter((handler) => {
		if (random() < 0.5) {
			handler.unsubscribe();

			return false;
		}

		return true;
	});

	for (let count = Math.floor(random() * 3); count > 0; count -= 1) {
		subscribe(Math.floor(random() * size));
	}

	await check(world, random, "after (un)subscribing", context);

	// A link's permissions change (a player seated).
	const at = Math.floor(random() * size);
	const peers = [...world.ends[at]!.keys()];

	if (peers.length > 0) {
		const peer = gen.pick(peers);
		const permissions = gen.permissions();

		world.hubs[at]!.permit("h" + peer, permissions);
		world.ends[at]!.set(peer, { ...world.ends[at]!.get(peer)!, "permissions": permissions });
		await check(world, random, `after h${at}.permit("h${peer}")`, context);
	}

	// A link goes: the tree splits in two.
	if (world.unlinks.size > 0) {
		const key = gen.pick([...world.unlinks.keys()]);
		const [child, parent] = key.split("|").map(Number) as [number, number];

		world.unlinks.get(key)!();
		world.unlinks.delete(key);
		world.ends[child]!.delete(parent);
		world.ends[parent]!.delete(child);
		await check(world, random, `after unlinking h${child} ⇄ h${parent}`, context);
	}

	for (const handler of world.handlers) {
		handler.unsubscribe();
	}

	for (const unlink of world.unlinks.values()) {
		unlink();
	}
}

test("the reference matcher is NATS matching", () => {
	assert.ok(refMatches("a.*", "a.b") && refMatches("a.>", "a.b.a") && refMatches(">", "b"));
	assert.ok(!refMatches("a.*", "a.b.a") && !refMatches("a.>", "a") && !refMatches("a.b", "a.a"));
});

test("hub routes as the reference does: random trees, permissions, non-transit links, and changes to each", async () => {
	const replay = process.env["HUB_MODEL_SEED"];
	const seeds = replay === undefined ? Array.from({ "length": 1000 }, (_, index) => index + 1) : [Number(replay)];

	for (const seed of seeds) {
		await runWorld(seed);
	}
});
