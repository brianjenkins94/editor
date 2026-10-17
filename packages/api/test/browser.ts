/** What a browser's fetch from one of our apps sends besides its credentials (BEHAVIOR.md): Origin, Fetch Metadata and its
 *  User-Agent. The tests' clients are browsers; without these, a sign-in is a script's (`client_unusual`). */
export const BROWSER: Record<string, string> = {
	"origin": "http://localhost:5173",
	"sec-fetch-site": "same-site",
	"sec-fetch-mode": "cors",
	"sec-fetch-dest": "empty",
	"user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
};
