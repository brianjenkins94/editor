import type { Bindings } from "./env.ts";

/**
 * Linked identities (migrations/0012; SIGN-IN.md, "Linking accounts"): each way of proving who you are, one row each,
 * pointing at its user. GitHub's account by its numeric id (as text), an email by its address as typed; matched
 * whatever the case. Only here reads or writes the table.
 */

export type Provider = "github" | "email";

export interface Identity { "subject": string; "verifiedAt": number | null }

/** The user's identity with `provider`, if it has one. */
export async function identityOf(env: Bindings, user: string, provider: Provider): Promise<Identity | null> {
	const row = await env.DB.prepare("SELECT subject, verified_at FROM identities WHERE user_id = ? AND provider = ?").bind(user, provider).first<{ "subject": string; "verified_at": number | null }>();

	return row === null ? null : { "subject": row.subject, "verifiedAt": row.verified_at };
}

/** The user's GitHub id, if a GitHub account is linked. */
export async function githubIdOf(env: Bindings, user: string): Promise<number | null> {
	const github = await identityOf(env, user, "github");

	return github === null ? null : Number(github.subject);
}

/** The user's email address, if one is linked. */
export async function emailOf(env: Bindings, user: string): Promise<string | null> {
	return (await identityOf(env, user, "email"))?.subject ?? null;
}

/** Whose `subject` is, with `provider`: the user, or undefined. */
export async function ownerOf(env: Bindings, provider: Provider, subject: string): Promise<string | undefined> {
	return (await env.DB.prepare("SELECT user_id FROM identities WHERE provider = ? AND lower(subject) = lower(?)").bind(provider, subject).first<{ "user_id": string }>())?.user_id;
}

/**
 * The user `subject` belongs to, proven theirs just now (`verified_at` set): found, or a user made with it. Made in one
 * batch (a transaction), the user only if the identity is nobody's, so two first sign-ins at once make one user.
 */
export async function userWith(env: Bindings, provider: Provider, subject: string, now: number): Promise<string> {
	const id = crypto.randomUUID();
	const [, , , found] = await env.DB.batch([
		env.DB.prepare("INSERT INTO users (id, created_at) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM identities WHERE provider = ? AND lower(subject) = lower(?))").bind(id, now, provider, subject),
		env.DB.prepare("INSERT INTO identities (provider, subject, user_id, created_at, verified_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)").bind(provider, subject, id, now, now, id),
		env.DB.prepare("UPDATE identities SET verified_at = ? WHERE provider = ? AND lower(subject) = lower(?)").bind(now, provider, subject),
		env.DB.prepare("SELECT user_id FROM identities WHERE provider = ? AND lower(subject) = lower(?)").bind(provider, subject)
	]);

	return (found?.results[0] as { "user_id": string }).user_id;
}

/** Link `subject` to `user`, proven just now. False when it's someone else's already (ownerOf says whose). */
export async function link(env: Bindings, user: string, provider: Provider, subject: string, now: number): Promise<boolean> {
	const done = await env.DB.prepare("INSERT INTO identities (provider, subject, user_id, created_at, verified_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING").bind(provider, subject, user, now, now).run();

	return done.meta.changes === 1;
}

/** In SQL, the GitHub id of the user `users` row `alias` (null without one): for queries that list users. */
export const githubIdColumn = (alias: string): string => `(SELECT CAST(subject AS INTEGER) FROM identities WHERE identities.user_id = ${alias}.id AND identities.provider = 'github')`;
