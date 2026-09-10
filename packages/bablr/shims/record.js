/* global __BABLR_RECORD_STRICT__ -- a build-time vite define (see ../vite.config.ts), folded to `false`; eslint doesn't know it */
const {
	freeze,
	"deepFreezeRecord": deepFreezeRecord_,
	isFrozen,
	isSealed,
	"isDeepRecord": isDeepRecord_,
	getOwnPropertyNames,
	getOwnPropertySymbols,
	getOwnPropertyDescriptor,
	getPrototypeOf,
	setPrototypeOf
} = Object;
const { isArray } = Array;

const cache = new WeakSet();

const preimplemented = deepFreezeRecord_ && isDeepRecord_;

// Validation (the recursive `validate` walk plus a shallow check on every recordKeys/Values/Entries call) is a
// development aid that costs ~30% of a parse. It is off unless `globalThis[Symbol.for('@bablr/record:strict')]`
// is truthy at load time; the fast path still null-prototypes and freezes every record it is handed.
const strict = __BABLR_RECORD_STRICT__;

function isObjecty(value) {
	switch (typeof value) {
		case "object":
		case "function":
			return value !== null;
		default:
			return false;
	}
}

// bit 1: valid
// bit 2: deep valid

const validate = preimplemented
	? null
	: (value, transfer = false, shallow = false) => {
			if (!isObjecty(value) || cache.has(value)) { return 3; }

			const obj = value;

			if (!transfer && (getPrototypeOf(obj) !== null || !isFrozen(obj))) { return 0; }

			let status = 3;

			for (const name of getOwnPropertyNames(obj)) {
				const desc = getOwnPropertyDescriptor(obj, name);
				const { get, set, value } = desc;

				status &= (get || set ? 0 : 3) & (shallow ? 1 : validate(value, transfer));
			}

			for (const name of getOwnPropertySymbols(obj)) {
				const desc = getOwnPropertyDescriptor(obj, name);
				const { get, set, value } = desc;

				status &= (get || set ? 0 : 3) & (shallow ? 1 : validate(value, transfer));
			}

			if (transfer) {
				if (getPrototypeOf(obj) !== null) {
					setPrototypeOf(obj, null);
				}

				if (!isFrozen(obj)) { freeze(obj); }
				if (!shallow || status === 3) {
					cache.add(obj);
				}
			}

			return status;
		};

function fastFreezeRecord(obj) {
	if (getPrototypeOf(obj) !== null) { setPrototypeOf(obj, null); }
	if (!isFrozen(obj)) { freeze(obj); }

	return obj;
}

function fastDeepFreezeRecord(obj) {
	if (!isObjecty(obj) || cache.has(obj)) { return obj; }
	fastFreezeRecord(obj);
	cache.add(obj);
	for (const name of getOwnPropertyNames(obj)) { fastDeepFreezeRecord(obj[name]); }
	for (const name of getOwnPropertySymbols(obj)) { fastDeepFreezeRecord(obj[name]); }

	return obj;
}

const deepFreezeRecord = preimplemented
	? deepFreezeRecord_
	: !strict
			? fastDeepFreezeRecord
			: (obj) => {
					const result = validate(obj, true);

					if (result < 3) { throw new Error("@bablr/record: value is not a deep record"); }

					return obj;
				};

const isDeepRecord = preimplemented ? isDeepRecord_ : !strict ? () => true : (obj) => validate(obj) >= 3;

if (!isSealed(Object) && !preimplemented) {
	Object.deepFreezeRecord = deepFreezeRecord_
		? (obj) => {
				deepFreezeRecord(obj);

				return deepFreezeRecord_(obj);
			}
		: deepFreezeRecord;

	Object.isDeepRecord = isDeepRecord_
		? (obj) => isDeepRecord_(obj) || isDeepRecord(obj)
		: isDeepRecord;
}

const isRecord = !strict
	? () => true
	: (obj) => {
			return validate(obj, false, true) >= 1;
		};

const freezeRecord = !strict
	? fastFreezeRecord
	: (obj) => {
			const result = validate(obj, true, true);

			if (result < 1) { throw new Error("@bablr/record: value is not a record"); }

			return obj;
		};

function *recordKeys(obj) {
	if (!isRecord(obj)) { throw new Error("@bablr/record: value is not a record"); }

	if (isArray(obj)) {
		const { length } = obj;

		for (let i = 0; i < length; i++) { yield i; }
	} else {
		for (const key in obj) { yield key; }
	}
}

function *recordValues(obj) {
	if (!isRecord(obj)) { throw new Error("@bablr/record: value is not a record"); }

	if (isArray(obj)) {
		const { length } = obj;

		for (let i = 0; i < length; i++) { yield obj[i]; }
	} else {
		for (const key in obj) { yield obj[key]; }
	}
}

function *recordEntries(obj) {
	if (!isRecord(obj)) { throw new Error("@bablr/record: value is not a record"); }

	if (isArray(obj)) {
		const { length } = obj;

		for (let i = 0; i < length; i++) { yield [i, obj[i]]; }
	} else {
		for (const key in obj) { yield [key, obj[key]]; }
	}
}

function *arrayKeys(obj) {
	const { length } = obj;

	for (let i = 0; i < length; i++) { yield i; }
}

function *arrayValues(obj) {
	const { length } = obj;

	for (let i = 0; i < length; i++) { yield obj[i]; }
}

function *arrayEntries(obj) {
	const { length } = obj;

	for (let i = 0; i < length; i++) { yield [i, obj[i]]; }
}

export {
	arrayEntries,
	arrayKeys,
	arrayValues,
	deepFreezeRecord,
	freezeRecord,
	isDeepRecord,
	isRecord,
	recordEntries,
	recordKeys,
	recordValues
};
