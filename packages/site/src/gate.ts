import { createFacilitatorConfig } from "@coinbase/x402";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer as X402ResourceServer } from "@x402/hono";
import { Hono } from "hono";

// unusuallygood.dev's gate (packages/api/README.md, *A7 · production*): a browser goes on to the static assets (`_redirects`
// sends it to the editor); anything else is asked for $0.01 over x402 (https://www.x402.org) and goes on only once it
// pays. An experiment: does any scraper pay? Each bot request is one log line, so Workers Logs answers it.

interface Env {
	"ASSETS": Fetcher;
	/** Where a payment goes: the Coinbase account's USDC on Base deposit address. */
	"PAY_TO": string;
	/** A Coinbase Developer Platform API key (secrets): Coinbase's facilitator verifies and settles only with one. */
	"CDP_API_KEY_ID": string;
	"CDP_API_KEY_SECRET": string;
}

const BASE = "eip155:8453";

// Every current browser sends Sec-Fetch-Mode; curl, requests and most scraper libraries don't. A headless browser that
// says so, or a crawler that names itself, is asked anyway.
function isBrowser(request: Request) {
	const userAgent = request.headers.get("User-Agent") ?? "";

	return request.headers.has("Sec-Fetch-Mode") && userAgent.startsWith("Mozilla/") && !/bot|crawl|spider|headless/iu.test(userAgent);
}

let gate: Hono<{ "Bindings": Env }>;

// Built on the first request, not at load: the middleware asks the facilitator what it supports as it's made, and a
// Worker can't fetch in global scope. Coinbase's facilitator checks a payment's signature, then puts the transfer on
// chain and pays its gas; the USDC goes from the payer to PAY_TO, never through Coinbase or here.
function build(env: Env) {
	const server = new X402ResourceServer(new HTTPFacilitatorClient(createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET))).register(BASE, new ExactEvmScheme());

	return new Hono<{ "Bindings": Env }>()
		.use(async function(context, next) {
			await next();

			console.log(JSON.stringify({
				"path": context.req.path,
				"userAgent": context.req.header("User-Agent"),
				// v2's header; the middleware takes only it, so a v1 client's X-PAYMENT is a 402 again, but worth knowing about.
				"paid": context.req.header("PAYMENT-SIGNATURE") !== undefined,
				"paidV1": context.req.header("X-PAYMENT") !== undefined,
				"status": context.res.status
			}));
		})
		.use(paymentMiddleware({
			"/*": {
				"accepts": [{ "scheme": "exact", "price": "$0.01", "network": BASE, "payTo": env.PAY_TO }],
				"description": "unusuallygood.dev"
			}
		}, server))
		.all("*", function(context) {
			return context.env.ASSETS.fetch(context.req.raw);
		});
}

export default {
	"fetch": function(request: Request, env: Env, context: ExecutionContext) {
		if (isBrowser(request)) {
			return env.ASSETS.fetch(request);
		}

		gate ??= build(env);

		return gate.fetch(request, env, context);
	}
};
