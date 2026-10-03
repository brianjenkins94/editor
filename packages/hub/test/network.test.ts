/** The virtual network (src/network.ts): in-memory links on a simulated clock, faults seeded. (netsim's tests, moved
 *  here with it.) */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { createHub, createNetwork, matches } from "../src/index.ts";

const GAME = (subject: string): boolean => matches("game.*.state.*", subject);

function linked(faults = {}, seed = 1) {
	const network = createNetwork({ "seed": seed, "faulty": GAME });
	const left = createHub({ "id": "left" });
	const right = createHub({ "id": "right" });
	const received: unknown[] = [];

	right.subscribe("game.m.state.0", (data) => { received.push(data); });
	right.subscribe("other", (data) => { received.push(data); });
	network.link(left, right, faults);
	network.settle();

	return { "network": network, "left": left, "right": right, "received": received };
}

test("network: nothing arrives until the clock reaches the link's latency", () => {
	const { network, left, received } = linked({ "latencyMs": 30 });

	left.publish("other", 1);
	network.advance(29);
	assert.deepEqual(received, []);
	network.advance(1);
	assert.deepEqual(received, [1]);
});

test("network: without jitter, messages arrive in the order they were sent", () => {
	const { network, left, received } = linked();

	for (let index = 0; index < 20; index += 1) {
		left.publish("game.m.state.0", index);
	}

	network.settle();
	assert.deepEqual(received, Array.from({ "length": 20 }, (_, index) => index));
});

test("network: jitter reorders faultable messages; the same seed reorders them the same way", () => {
	const order = (seed: number) => {
		const { network, left, received } = linked({ "jitterMs": 40 }, seed);

		for (let index = 0; index < 30; index += 1) {
			left.publish("game.m.state.0", index);
		}

		network.settle();

		return received;
	};

	assert.notDeepEqual(order(3), Array.from({ "length": 30 }, (_, index) => index));
	assert.deepEqual(order(3), order(3));
	assert.equal(order(3).length, 30);
});

test("network: drops and duplicates hit only what `faulty` selects, deterministically", () => {
	const { network, left, received } = linked({ "drop": 0.3, "duplicate": 0.2 }, 5);

	for (let index = 0; index < 200; index += 1) {
		left.publish("game.m.state.0", index);
		left.publish("other", -1);
	}

	network.settle();

	const game = received.filter((value) => value !== -1);

	assert.equal(received.filter((value) => value === -1).length, 200, "the rest is never dropped or duplicated");
	assert.ok(network.stats.dropped > 30 && network.stats.dropped < 90, `dropped ${network.stats.dropped}`);
	assert.ok(network.stats.duplicated > 10, `duplicated ${network.stats.duplicated}`);
	assert.equal(game.length, 200 - network.stats.dropped + network.stats.duplicated);
});

test("network: by default every message but the system's is faultable; control frames never are", () => {
	const network = createNetwork({ "random": () => 0 }); // every chance taken: drop everything faultable
	const left = createHub({ "id": "left" });
	const right = createHub({ "id": "right" });
	const received: unknown[] = [];

	right.subscribe("anything", (data) => { received.push(data); });
	right.subscribe("$sys.log.left", (data) => { received.push(data); });
	network.link(left, right, { "drop": 1 });
	network.settle();
	assert.ok(left.interested("anything"), "interest (control frames) still propagated");
	left.publish("anything", "lost");
	left.publish("$sys.log.left", "kept");
	network.settle();
	assert.deepEqual(received, ["kept"]);
});

test("network: unlinking stops delivery, including messages already in flight", () => {
	const network = createNetwork();
	const left = createHub();
	const right = createHub();
	const received: unknown[] = [];

	right.subscribe("other", (data) => { received.push(data); });

	const unlink = network.link(left, right);

	network.settle();
	left.publish("other", 1);
	unlink();
	network.settle();
	assert.deepEqual(received, []);
	assert.equal(network.now() > 0, true);
});
