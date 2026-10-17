/**
 * GitHub logins, looked up live by id and never stored (packages/api/README.md, "Identity and the data we keep";
 * decided 2026-10-17): GitHub's public `GET /user/{id}`, unauthenticated (60 an hour), so only what's on screen is
 * asked for, once per session.
 */
const known = new Map<number, Promise<string | undefined>>();

export function loginOf(githubId: number): Promise<string | undefined> {
	if (!known.has(githubId)) {
		const cached = sessionStorage.getItem(`admin:login:${githubId}`);

		known.set(githubId, cached !== null ? Promise.resolve(cached) : fetch(`https://api.github.com/user/${githubId}`, { "headers": { "accept": "application/vnd.github+json" } })
			.then(async (response) => (response.ok ? (await response.json() as { "login": string }).login : undefined))
			.then((login) => {
				if (login !== undefined) {
					sessionStorage.setItem(`admin:login:${githubId}`, login);
				}

				return login;
			})
			.catch(() => undefined));
	}

	return known.get(githubId) as Promise<string | undefined>;
}
