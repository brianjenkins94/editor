/**
 * The editor's API stood in for, at a test's routes (page.route): its sign-in — the pushed request, its start page sending
 * the browser straight back with a code, the token, the account — and its proxy to GitHub, answered by a GitHub of the
 * test's own: who's signed in, a repository and its tree and blobs, and git over HTTP (a clone, a fetch, a push) from
 * repositories kept here as git keeps objects. For an editor opened with `?api=/__test-api` (shell/session.ts), whose API
 * is then its own origin's /__test-api. Nothing real is touched.
 */
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

export const TEST_API = "/__test-api";

const ZERO = "0".repeat(40);
const TYPES = { "commit": 1, "tree": 2, "blob": 3, "tag": 4 };
const NAMES = Object.fromEntries(Object.entries(TYPES).map(([name, code]) => [code, name]));

const pkt = (payload) => {
	const bytes = typeof payload === "string" ? Buffer.from(payload) : Buffer.from(payload);

	return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, "0")), bytes]);
};
const FLUSH = Buffer.from("0000");

/** pkt-lines from `bytes`, until a flush or the end: each line's payload, and where the rest starts. */
function readLines(bytes, from = 0) {
	const lines = [];
	let at = from;

	while (at + 4 <= bytes.length) {
		const length = Number.parseInt(bytes.subarray(at, at + 4).toString(), 16);

		at += 4;

		if (length === 0) {
			break;
		}

		lines.push(bytes.subarray(at, at + length - 4).toString());
		at += length - 4;
	}

	return { "lines": lines, "rest": at };
}

/** Each chunk of `bytes` as side-band 1 (side-band-64k), then a flush. */
const banded = (bytes) => {
	const parts = [];

	for (let at = 0; at < bytes.length; at += 65_515) {
		parts.push(pkt(Buffer.concat([Buffer.from([1]), bytes.subarray(at, at + 65_515)])));
	}

	return Buffer.concat([...parts, FLUSH]);
};

const adler32 = (bytes) => {
	let a = 1;
	let b = 0;

	for (const byte of bytes) {
		a = (a + byte) % 65_521;
		b = (b + a) % 65_521;
	}

	return ((b << 16) | a) >>> 0;
};

/** A repository as git keeps one: objects by id, and its branches. */
class Repository {
	objects = new Map();
	refs = new Map();

	put(type, body) {
		const bytes = Buffer.from(body);
		const id = createHash("sha1").update(Buffer.concat([Buffer.from(`${type} ${String(bytes.length)}\0`), bytes])).digest("hex");

		this.objects.set(id, { "type": type, "body": bytes });

		return id;
	}

	get(id) {
		return this.objects.get(id);
	}

	/** A tree of `files` ({ path: text }), its folders trees of their own. */
	tree(files) {
		const here = new Map();

		for (const [path, text] of Object.entries(files)) {
			const [first, ...rest] = path.split("/");

			if (rest.length === 0) {
				here.set(first, { "mode": "100644", "id": this.put("blob", text) });
			} else {
				here.set(first, { ...here.get(first), "folder": { ...here.get(first)?.folder, [rest.join("/")]: text } });
			}
		}

		const entries = [...here].map(([name, entry]) => (entry.folder === undefined ? { name, ...entry } : { name, "mode": "40000", "id": this.tree(entry.folder) }));

		entries.sort((one, other) => (one.mode === "40000" ? `${one.name}/` : one.name).localeCompare(other.mode === "40000" ? `${other.name}/` : other.name));

		return this.put("tree", Buffer.concat(entries.map(({ mode, name, id }) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(id, "hex")]))));
	}

	entries(id) {
		const body = this.get(id).body;
		const entries = [];
		let at = 0;

		while (at < body.length) {
			const space = body.indexOf(32, at);
			const zero = body.indexOf(0, space);

			entries.push({ "mode": body.subarray(at, space).toString(), "name": body.subarray(space + 1, zero).toString(), "id": body.subarray(zero + 1, zero + 21).toString("hex") });
			at = zero + 21;
		}

		return entries;
	}

	/** Every file of a tree: path → blob id. */
	files(tree, prefix = "") {
		return Object.fromEntries(this.entries(tree).flatMap(({ mode, name, id }) => (mode === "40000" ? Object.entries(this.files(id, `${prefix}${name}/`)) : [[`${prefix}${name}`, id]])));
	}

	commitOf(id) {
		const text = this.get(id).body.toString();
		const [head, ...message] = text.split("\n\n");
		const field = (name) => head.split("\n").filter((line) => line.startsWith(`${name} `)).map((line) => line.slice(name.length + 1));

		return { "tree": field("tree")[0], "parents": field("parent"), "author": field("author")[0], "message": message.join("\n\n").trim() };
	}

	/** A commit on `branch` of `files` (merged onto what's there) by `author`. */
	commit(files, message, { branch = "main", author = "Ann <ann@example.com>" } = {}) {
		const parent = this.refs.get(`refs/heads/${branch}`);
		const before = parent === undefined ? {} : Object.fromEntries(Object.entries(this.files(this.commitOf(parent).tree)).map(([path, id]) => [path, this.get(id).body]));
		const when = `${String(1_800_000_000 + this.objects.size)} +0000`;
		const id = this.put("commit", `tree ${this.tree({ ...before, ...files })}\n${parent === undefined ? "" : `parent ${parent}\n`}author ${author} ${when}\ncommitter ${author} ${when}\n\n${message}\n`);

		this.refs.set(`refs/heads/${branch}`, id);

		return id;
	}

	/** What the tip of `branch` is: its message, author and files' texts. */
	tip(branch = "main") {
		const commit = this.commitOf(this.refs.get(`refs/heads/${branch}`));

		return { ...commit, "files": Object.fromEntries(Object.entries(this.files(commit.tree)).map(([path, id]) => [path, this.get(id).body.toString()])) };
	}

	reachable(tips, depth = Infinity, stop = new Set()) {
		const commits = new Map();
		let edge = tips.map((id) => [id, 1]);

		while (edge.length > 0) {
			const next = [];

			for (const [id, at] of edge) {
				if (commits.has(id) || stop.has(id) || this.get(id) === undefined) {
					continue;
				}

				commits.set(id, at);

				if (at < depth) {
					next.push(...this.commitOf(id).parents.map((parent) => [parent, at + 1]));
				}
			}

			edge = next;
		}

		return commits;
	}

	/** A pack of `ids`, each whole. */
	pack(ids) {
		const parts = [Buffer.from("PACK"), Buffer.from([0, 0, 0, 2]), Buffer.from([ids.length >>> 24, (ids.length >>> 16) & 255, (ids.length >>> 8) & 255, ids.length & 255])];

		for (const id of ids) {
			const { type, body } = this.get(id);
			let size = body.length;
			const header = [(TYPES[type] << 4) | (size & 15)];

			size >>>= 4;

			while (size > 0) {
				header[header.length - 1] |= 128;
				header.push(size & 127);
				size >>>= 7;
			}

			parts.push(Buffer.from(header), deflateSync(body));
		}

		const pack = Buffer.concat(parts);

		return Buffer.concat([pack, createHash("sha1").update(pack).digest()]);
	}

	/** A pack's objects, kept: whole ones, as isomorphic-git sends (no deltas). */
	unpack(pack) {
		const count = pack.readUInt32BE(8);
		let at = 12;

		for (let index = 0; index < count; index += 1) {
			let byte = pack[at];
			const type = NAMES[(byte >> 4) & 7];

			if (type === undefined) {
				throw new Error(`a pack object of type ${String((byte >> 4) & 7)}: deltas aren't kept here`);
			}

			while (byte & 128) {
				at += 1;
				byte = pack[at];
			}

			at += 1;

			const body = inflateSync(pack.subarray(at));
			const check = adler32(body);
			let end = at + 2;

			// (where its zlib stream ends: its Adler-32, after it)
			while (end + 4 <= pack.length && pack.readUInt32BE(end) !== check) {
				end += 1;
			}

			this.put(type, body);
			at = end + 4;
		}
	}

	upload(request) {
		const { lines, rest } = readLines(request);
		const wants = lines.filter((line) => line.startsWith("want ")).map((line) => line.slice(5, 45));
		const deepen = lines.find((line) => line.startsWith("deepen "));
		const depth = deepen === undefined ? Infinity : Number(deepen.slice(7));
		const haves = readLines(request, rest).lines.filter((line) => line.startsWith("have ")).map((line) => line.slice(5, 45)).filter((id) => this.get(id) !== undefined);
		const had = new Set(this.reachable(haves).keys());
		const commits = this.reachable(wants, depth, had);
		const ids = new Set();
		const walk = (tree) => {
			ids.add(tree);

			for (const { mode, id } of this.entries(tree)) {
				if (mode === "40000") {
					walk(id);
				} else {
					ids.add(id);
				}
			}
		};

		for (const id of commits.keys()) {
			ids.add(id);
			walk(this.commitOf(id).tree);
		}

		const shallows = [...commits].filter(([id, at]) => at === depth && this.commitOf(id).parents.length > 0).map(([id]) => pkt(`shallow ${id}\n`));

		return Buffer.concat([...deepen === undefined ? [] : [...shallows, FLUSH], pkt("NAK\n"), banded(this.pack([...ids]))]);
	}

	receive(request) {
		const { lines, rest } = readLines(request);
		const updates = lines.map((line) => line.split("\0")[0].trim().split(" "));

		if (rest < request.length) {
			this.unpack(request.subarray(rest));
		}

		const said = updates.map(([before, after, ref]) => {
			if ((this.refs.get(ref) ?? ZERO) !== before) {
				return pkt(`ng ${ref} fetch first\n`);
			}

			if (after === ZERO) {
				this.refs.delete(ref);
			} else {
				this.refs.set(ref, after);
			}

			return pkt(`ok ${ref}\n`);
		});

		return banded(Buffer.concat([pkt("unpack ok\n"), ...said, FLUSH]));
	}

	advertise(service) {
		const caps = service === "git-upload-pack" ? "side-band-64k shallow no-progress symref=HEAD:refs/heads/main agent=stand-in" : "report-status side-band-64k delete-refs agent=stand-in";
		const refs = [...this.refs];
		const head = this.refs.get("refs/heads/main");
		const listed = service === "git-upload-pack" && head !== undefined ? [["HEAD", head], ...refs] : refs;
		const lines = listed.length === 0 ? [pkt(`${ZERO} capabilities^{}\0${caps}\n`)] : listed.map(([name, id], index) => pkt(`${id} ${name}${index === 0 ? `\0${caps}` : ""}\n`));

		return Buffer.concat([pkt(`# service=${service}\n`), FLUSH, ...lines, FLUSH]);
	}
}

/**
 * The API and its GitHub, for one person signed in. `repositories`: "owner/repo" → { files, message }, each made a
 * repository of one commit. Returns its routes' handler, each repository (`repository("ann/app")`), what the sign-in pushed
 * and started with (`seen`), and every call (`asked`).
 */
export function apiStandIn({ person = { "id": 4242, "login": "ann" }, repositories = {} } = {}) {
	const kept = new Map(Object.entries(repositories).map(([name, { files, message }]) => {
		const repository = new Repository();

		repository.commit(files, message);

		return [name, repository];
	}));
	const seen = { "pushed": undefined, "proof": undefined, "started": undefined };
	const asked = [];

	const handle = async (route, request) => {
		const url = new URL(request.url());
		const api = `${url.origin}${TEST_API}`;
		const path = url.pathname.slice(TEST_API.length);
		const json = async (value, status = 200) => route.fulfill({ "status": status, "json": value });

		asked.push(`${request.method()} ${path}`);

		if (path === "/auth/par") {
			seen.pushed = new URLSearchParams(request.postData() ?? "");
			seen.proof = request.headers()["dpop"];

			return json({ "request_uri": "urn:ietf:params:oauth:request_uri:stand-in", "expires_in": 60 }, 201);
		}

		if (path === "/auth/start") {
			seen.started = url.searchParams;

			return route.fulfill({ "status": 302, "headers": { "location": `${url.origin}/?${new URLSearchParams({ "code": "stand-in", "state": seen.pushed?.get("state") ?? "", "iss": api })}` } });
		}

		if (path === "/token") {
			return json({ "access_token": "stand-in", "token_type": "DPoP", "refresh_token": "stand-in", "expires_in": 3600 });
		}

		if (path === "/account") {
			return json({ "user": `u-${person.login}`, "githubId": person.id, "email": null });
		}

		if (path === "/github/api/user") {
			return json({ "id": person.id, "login": person.login, "name": null });
		}

		const rest = /^\/github\/api\/repos\/([\w.-]+\/[\w.-]+)(?:\/git\/(trees|blobs)\/([\w./-]+))?$/u.exec(path);

		if (rest !== null) {
			const repository = kept.get(rest[1]);

			if (repository === undefined) {
				return json({ "message": "Not Found" }, 404);
			}

			if (rest[2] === undefined) {
				return json({ "name": rest[1].split("/")[1], "full_name": rest[1], "private": false, "default_branch": "main", "permissions": { "admin": true, "push": true, "pull": true } });
			}

			if (rest[2] === "blobs") {
				return json({ "sha": rest[3], "encoding": "base64", "content": repository.get(rest[3]).body.toString("base64") });
			}

			const tip = repository.refs.get(rest[3] === "HEAD" ? "refs/heads/main" : `refs/heads/${rest[3]}`) ?? rest[3];
			const files = repository.files(repository.commitOf(tip).tree);

			return json({ "tree": Object.entries(files).map(([file, id]) => ({ "path": file, "mode": "100644", "type": "blob", "sha": id, "size": repository.get(id).body.length })), "truncated": false });
		}

		const git = /^\/github\/git\/([\w.-]+\/[\w.-]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/u.exec(path);

		if (git !== null) {
			const repository = kept.get(git[1]);

			if (repository === undefined) {
				return route.fulfill({ "status": 404, "body": "Repository not found." });
			}

			if (git[2] === "info/refs") {
				const service = url.searchParams.get("service");

				return route.fulfill({ "headers": { "content-type": `application/x-${service}-advertisement` }, "body": repository.advertise(service) });
			}

			const body = Buffer.from(request.postDataBuffer() ?? []);

			return route.fulfill({ "headers": { "content-type": `application/x-${git[2]}-result` }, "body": git[2] === "git-upload-pack" ? repository.upload(body) : repository.receive(body) });
		}

		return json({});
	};

	return { "handle": handle, "repository": (name) => kept.get(name), "seen": seen, "asked": asked };
}
