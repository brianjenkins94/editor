/**
 * Node.js https module shim
 * Re-exports http module functionality with https protocol default
 */

import type { AgentOptions, RequestOptions } from "./http";

import {
	_createClientRequest,
	Agent,
	ClientRequest,
	createServer,
	getAllServers,
	getServer,
	globalAgent,
	IncomingMessage,
	METHODS,
	Server,
	ServerResponse,
	setServerCloseCallback,
	setServerListenCallback,
	STATUS_CODES
} from "./http";

// Re-export all http types and classes
export {
	Agent,
	ClientRequest,
	createServer,
	getAllServers,
	getServer,
	globalAgent,
	IncomingMessage,
	METHODS,
	Server,
	ServerResponse,
	setServerCloseCallback,
	setServerListenCallback,
	STATUS_CODES
};

export type { AgentOptions };

export type { RequestOptions };

/**
 * Create an HTTPS client request
 */
export function request(
	urlOrOptions: string | URL | RequestOptions,
	optionsOrCallback?: RequestOptions | ((res: IncomingMessage) => void),
	callback?: (res: IncomingMessage) => void
): ClientRequest {
	return _createClientRequest(urlOrOptions, optionsOrCallback, callback, "https");
}

/**
 * Make an HTTPS GET request
 */
export function get(
	urlOrOptions: string | URL | RequestOptions,
	optionsOrCallback?: RequestOptions | ((res: IncomingMessage) => void),
	callback?: (res: IncomingMessage) => void
): ClientRequest {
	const req = _createClientRequest(urlOrOptions, optionsOrCallback, callback, "https");

	req.end();

	return req;
}

export default {
	"Server": Server,
	"IncomingMessage": IncomingMessage,
	"ServerResponse": ServerResponse,
	"ClientRequest": ClientRequest,
	"createServer": createServer,
	"request": request,
	"get": get,
	"STATUS_CODES": STATUS_CODES,
	"METHODS": METHODS,
	"getServer": getServer,
	"getAllServers": getAllServers,
	"setServerListenCallback": setServerListenCallback,
	"setServerCloseCallback": setServerCloseCallback,
	"Agent": Agent,
	"globalAgent": globalAgent
};
