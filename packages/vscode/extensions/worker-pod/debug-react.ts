/**
 * M3c render engine — a react-reconciler custom renderer that runs in the debug worker and drives a GUEST
 * React app (component functions interpreted by tsval). Instead of a DOM it emits a serializable MUTATION
 * stream keyed by node id, which the adapter bridges to the preview iframe to apply to the real DOM.
 *
 * Two things make this the right shape for a debugger:
 * - Component functions and event handlers are guest values, so the reconciler invokes them synchronously
 *   through tsval → a breakpoint inside them pauses via the M3b Atomics path.
 * - Handlers are functions and can't be serialized to the iframe, so they stay HERE: each `on*` prop registers
 *   the guest handler under (nodeId, event) and emits a `setHandler` marker; a DOM event in the iframe comes
 *   back as (nodeId, event) and `dispatch` invokes the guest handler synchronously. `setState` in it triggers
 *   React to re-render → new mutations → the iframe updates.
 */
import type ReactNamespace from "react";
import Reconciler from "react-reconciler";
import { DefaultEventPriority } from "react-reconciler/constants.js";

export type Mutation =
	| { "op": "createElement"; "id": number; "type": string }
	| { "op": "createText"; "id": number; "text": string }
	| { "op": "setProp"; "id": number; "name": string; "value": unknown }
	| { "op": "removeProp"; "id": number; "name": string }
	| { "op": "setHandler"; "id": number; "event": string; "present": boolean }
	| { "op": "setText"; "id": number; "text": string }
	| { "op": "appendChild"; "parent": number | "root"; "child": number }
	| { "op": "insertBefore"; "parent": number | "root"; "child": number; "before": number }
	| { "op": "removeChild"; "parent": number | "root"; "child": number };

interface Instance { "id": number; "type": string }
interface TextInstance { "id": number }
type Container = { "id": "root" };

export interface GuestRoot {
	/** Render a React element (typically `React.createElement(App)`) — mount or update. Runs the guest
	 *  components synchronously through tsval, so a breakpoint inside one pauses (M3b). */
	"render": (element: unknown) => void;
	/** Invoke the guest handler registered for (nodeId, event) — a DOM event routed back from the iframe. Runs
	 *  synchronously through tsval, so a breakpoint inside the handler pauses (M3b). */
	"dispatch": (id: number, event: string) => void;
	"unmount": () => void;
}

/** Map a React `on*` prop to a DOM event name (onClick → click, onInput → input, …). */
function eventName(prop: string): string {
	return prop.slice(2).toLowerCase();
}

function isHandlerProp(name: string, value: unknown): boolean {
	return typeof value === "function" && name.length > 2 && name.startsWith("on") && name[2] === name[2]?.toUpperCase();
}

/**
 * Create a render root that emits mutations to `emit`. `render(element)` mounts/updates a guest React tree.
 * `React` is the SAME native React the guest is given (so guest `createElement`/`useState` reach this
 * reconciler's active render). The guest's ReactDOM shim calls `render` from `createRoot().render(...)`.
 */
export function createGuestRoot(React: typeof ReactNamespace, emit: (mutation: Mutation) => void): GuestRoot {
	let nextId = 1;
	// (nodeId → event → guest handler). Kept worker-side; never serialized.
	const handlers = new Map<number, Map<string, (event: unknown) => void>>();

	const setHandler = (id: number, event: string, fn: ((event: unknown) => void) | undefined): void => {
		let byEvent = handlers.get(id);

		if (fn === undefined) {
			byEvent?.delete(event);
			emit({ "op": "setHandler", "id": id, "event": event, "present": false });

			return;
		}

		if (byEvent === undefined) {
			byEvent = new Map();
			handlers.set(id, byEvent);
		}

		byEvent.set(event, fn);
		emit({ "op": "setHandler", "id": id, "event": event, "present": true });
	};

	const applyProp = (id: number, name: string, value: unknown): void => {
		if (name === "children") {
			return;
		}

		if (isHandlerProp(name, value)) {
			setHandler(id, eventName(name), value as (event: unknown) => void);
		} else {
			emit({ "op": "setProp", "id": id, "name": name, "value": value });
		}
	};

	const hostConfig: Reconciler.HostConfig<string, Record<string, unknown>, Container, Instance, TextInstance, never, never, Instance, unknown, unknown, number, number, number> & Record<string, unknown> = {
		"supportsMutation": true,
		"supportsPersistence": false,
		"supportsHydration": false,
		"isPrimaryRenderer": true,
		"noTimeout": -1,
		"scheduleTimeout": setTimeout,
		"cancelTimeout": clearTimeout,
		"now": Date.now,
		"getRootHostContext": () => ({}),
		"getChildHostContext": () => ({}),
		"prepareForCommit": () => null,
		"resetAfterCommit": () => undefined,
		"preparePortalMount": () => undefined,
		"getCurrentEventPriority": () => DefaultEventPriority,
		"shouldSetTextContent": () => false,
		"createInstance": (type: string, props: Record<string, unknown>): Instance => {
			const instance: Instance = { "id": nextId++, "type": type };
			emit({ "op": "createElement", "id": instance.id, "type": type });

			for (const name of Object.keys(props)) {
				applyProp(instance.id, name, props[name]);
			}

			return instance;
		},
		"createTextInstance": (text: string): TextInstance => {
			const instance: TextInstance = { "id": nextId++ };
			emit({ "op": "createText", "id": instance.id, "text": text });

			return instance;
		},
		"appendInitialChild": (parent: Instance, child: Instance | TextInstance) => emit({ "op": "appendChild", "parent": parent.id, "child": child.id }),
		"finalizeInitialChildren": () => false,
		"appendChild": (parent: Instance, child: Instance | TextInstance) => emit({ "op": "appendChild", "parent": parent.id, "child": child.id }),
		"appendChildToContainer": (_container: Container, child: Instance | TextInstance) => emit({ "op": "appendChild", "parent": "root", "child": child.id }),
		"insertBefore": (parent: Instance, child: Instance | TextInstance, before: Instance | TextInstance) => emit({ "op": "insertBefore", "parent": parent.id, "child": child.id, "before": before.id }),
		"insertInContainerBefore": (_container: Container, child: Instance | TextInstance, before: Instance | TextInstance) => emit({ "op": "insertBefore", "parent": "root", "child": child.id, "before": before.id }),
		"removeChild": (parent: Instance, child: Instance | TextInstance) => { handlers.delete(child.id); emit({ "op": "removeChild", "parent": parent.id, "child": child.id }); },
		"removeChildFromContainer": (_container: Container, child: Instance | TextInstance) => { handlers.delete(child.id); emit({ "op": "removeChild", "parent": "root", "child": child.id }); },
		"clearContainer": () => undefined,
		// Return a truthy payload so commitUpdate runs; the diff is recomputed there from old/new props.
		"prepareUpdate": () => ({}),
		"commitUpdate": (instance: Instance, _payload: unknown, _type: string, oldProps: Record<string, unknown>, newProps: Record<string, unknown>) => {
			for (const name of Object.keys(oldProps)) {
				if (name !== "children" && !(name in newProps)) {
					if (isHandlerProp(name, oldProps[name])) {
						setHandler(instance.id, eventName(name), undefined);
					} else {
						emit({ "op": "removeProp", "id": instance.id, "name": name });
					}
				}
			}

			for (const name of Object.keys(newProps)) {
				if (name !== "children" && newProps[name] !== oldProps[name]) {
					applyProp(instance.id, name, newProps[name]);
				}
			}
		},
		"commitTextUpdate": (instance: TextInstance, _old: string, next: string) => emit({ "op": "setText", "id": instance.id, "text": next }),
		"getPublicInstance": (instance: Instance) => instance,
		"getInstanceFromNode": () => null,
		"getInstanceFromScope": () => null,
		"beforeActiveInstanceBlur": () => undefined,
		"afterActiveInstanceBlur": () => undefined,
		"prepareScopeUpdate": () => undefined,
		"detachDeletedInstance": (instance: Instance | TextInstance) => handlers.delete(instance.id),
		"maySuspendCommit": () => false
	};

	const reconciler = Reconciler(hostConfig as unknown as Reconciler.HostConfig<string, Record<string, unknown>, Container, Instance, TextInstance, never, never, Instance, unknown, unknown, number, number, number>);
	const root = reconciler.createContainer({ "id": "root" }, 0, null, false, null, "", () => undefined, null);

	return {
		"render": (element: unknown) => reconciler.updateContainer(element as React.ReactNode, root, null, () => undefined),
		"dispatch": (id: number, event: string) => {
			const fn = handlers.get(id)?.get(event);

			if (fn !== undefined) {
				// Synchronous → routes through tsval's callGuestFromHost; a breakpoint inside pauses (M3b).
				fn({ "type": event });
			}
		},
		"unmount": () => reconciler.updateContainer(null, root, null, () => undefined)
	};
}
