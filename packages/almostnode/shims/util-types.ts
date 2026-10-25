/**
 * almostnode's `util/types` (builtins.ts), as Node's answer — Node's are native (V8's own checks), so there's no port on
 * npm. unenv's said most weren't implemented, and its boxed-primitive checks were the opposite of Node's
 * (`isBooleanObject(true)` true, `isBooleanObject(new Boolean(true))` false). Each here asks what the value is by a brand
 * check — a built-in's own method or getter, which throws or answers undefined for anything else — so a value from
 * another realm, or one claiming another `Symbol.toStringTag`, is told as Node tells it; and where there's no brand check,
 * by its tag. `isProxy` and `isKeyObject` stay unenv's: a Proxy can't be told from the object it wraps, and almostnode's
 * crypto has no KeyObject.
 */

/** Whether `check` accepts `value` (a brand check: it throws for any other kind of value). */
function branded(value: unknown, check: (value: unknown) => unknown): boolean {
	if (value === null || typeof value !== "object") {
		return false;
	}

	try {
		check(value);

		return true;
	} catch {
		return false;
	}
}

const tag = (value: unknown): string => Object.prototype.toString.call(value).slice(8, -1);
const getter = (prototype: object, name: PropertyKey): (this: unknown) => unknown => Object.getOwnPropertyDescriptor(prototype, name)?.get as (this: unknown) => unknown;
/** A typed array's own name (`Uint8Array`, …), or undefined for anything else: TypedArray.prototype's toStringTag getter. */
const typedArrayName = (value: unknown): string | undefined => getter(Object.getPrototypeOf(Uint8Array.prototype) as object, Symbol.toStringTag).call(value) as string | undefined;
const typed = (name: string) => (value: unknown): boolean => typedArrayName(value) === name;

export const isBooleanObject = (value: unknown): boolean => branded(value, (each) => Boolean.prototype.valueOf.call(each));
export const isNumberObject = (value: unknown): boolean => branded(value, (each) => Number.prototype.valueOf.call(each));
export const isStringObject = (value: unknown): boolean => branded(value, (each) => String.prototype.valueOf.call(each));
export const isSymbolObject = (value: unknown): boolean => branded(value, (each) => Symbol.prototype.valueOf.call(each));
export const isBigIntObject = (value: unknown): boolean => branded(value, (each) => BigInt.prototype.valueOf.call(each));
export const isBoxedPrimitive = (value: unknown): boolean => isBooleanObject(value) || isNumberObject(value) || isStringObject(value) || isSymbolObject(value) || isBigIntObject(value);
export const isDate = (value: unknown): boolean => branded(value, (each) => Date.prototype.getTime.call(each));
export const isRegExp = (value: unknown): boolean => branded(value, (each) => getter(RegExp.prototype, "source").call(each));
export const isMap = (value: unknown): boolean => branded(value, (each) => getter(Map.prototype, "size").call(each));
export const isSet = (value: unknown): boolean => branded(value, (each) => getter(Set.prototype, "size").call(each));
export const isWeakMap = (value: unknown): boolean => branded(value, (each) => WeakMap.prototype.has.call(each as WeakMap<object, unknown>, {}));
export const isWeakSet = (value: unknown): boolean => branded(value, (each) => WeakSet.prototype.has.call(each as WeakSet<object>, {}));
export const isArrayBuffer = (value: unknown): boolean => branded(value, (each) => getter(ArrayBuffer.prototype, "byteLength").call(each));
export const isSharedArrayBuffer = (value: unknown): boolean => typeof SharedArrayBuffer !== "undefined" && branded(value, (each) => getter(SharedArrayBuffer.prototype, "byteLength").call(each));
export const isAnyArrayBuffer = (value: unknown): boolean => isArrayBuffer(value) || isSharedArrayBuffer(value);
export const isDataView = (value: unknown): boolean => branded(value, (each) => getter(DataView.prototype, "byteLength").call(each));
export const isArrayBufferView = (value: unknown): boolean => ArrayBuffer.isView(value);
export const isTypedArray = (value: unknown): boolean => typedArrayName(value) !== undefined;
export const isUint8Array = typed("Uint8Array");
export const isUint8ClampedArray = typed("Uint8ClampedArray");
export const isUint16Array = typed("Uint16Array");
export const isUint32Array = typed("Uint32Array");
export const isInt8Array = typed("Int8Array");
export const isInt16Array = typed("Int16Array");
export const isInt32Array = typed("Int32Array");
export const isFloat32Array = typed("Float32Array");
export const isFloat64Array = typed("Float64Array");
export const isBigInt64Array = typed("BigInt64Array");
export const isBigUint64Array = typed("BigUint64Array");
// (no brand check for these: their tags, which only their own kind has unless something claims it)
export const isPromise = (value: unknown): boolean => value instanceof Promise || tag(value) === "Promise";
export const isNativeError = (value: unknown): boolean => value instanceof Error || tag(value) === "Error";
export const isArgumentsObject = (value: unknown): boolean => tag(value) === "Arguments";
export const isAsyncFunction = (value: unknown): boolean => typeof value === "function" && ["AsyncFunction", "AsyncGeneratorFunction"].includes(tag(value));
export const isGeneratorFunction = (value: unknown): boolean => typeof value === "function" && ["GeneratorFunction", "AsyncGeneratorFunction"].includes(tag(value));
export const isGeneratorObject = (value: unknown): boolean => ["Generator", "AsyncGenerator"].includes(tag(value));
export const isMapIterator = (value: unknown): boolean => tag(value) === "Map Iterator";
export const isSetIterator = (value: unknown): boolean => tag(value) === "Set Iterator";
export const isModuleNamespaceObject = (value: unknown): boolean => tag(value) === "Module" && Object.getPrototypeOf(value) === null;
export const isCryptoKey = (value: unknown): boolean => typeof CryptoKey !== "undefined" && value instanceof CryptoKey;
export const isExternal = (): boolean => false;
