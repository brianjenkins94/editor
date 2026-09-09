let {
  freeze,
  deepFreezeRecord: deepFreezeRecord_,
  isFrozen,
  isSealed,
  isDeepRecord: isDeepRecord_,
  getOwnPropertyNames,
  getOwnPropertySymbols,
  getOwnPropertyDescriptor,
  getPrototypeOf,
  setPrototypeOf,
} = Object;
let { isArray } = Array;

let cache = new WeakSet();

let preimplemented = deepFreezeRecord_ && isDeepRecord_;

// Validation (the recursive `validate` walk plus a shallow check on every recordKeys/Values/Entries call) is a
// development aid that costs ~30% of a parse. It is off unless `globalThis[Symbol.for('@bablr/record:strict')]`
// is truthy at load time; the fast path still null-prototypes and freezes every record it is handed.
const strict = __BABLR_RECORD_STRICT__;

let isObjecty = (value) => {
  switch (typeof value) {
    case 'object':
    case 'function':
      return value !== null;
    default:
      return false;
  }
};

// bit 1: valid
// bit 2: deep valid

let validate = preimplemented
  ? null
  : (value, transfer = false, shallow = false) => {
      if (!isObjecty(value) || cache.has(value)) return 3;

      let obj = value;

      if (!transfer && (getPrototypeOf(obj) !== null || !isFrozen(obj))) return 0;

      let status = 3;

      for (let name of getOwnPropertyNames(obj)) {
        let desc = getOwnPropertyDescriptor(obj, name);
        let { get, set, value } = desc;
        status &= (get || set ? 0 : 3) & (shallow ? 1 : validate(value, transfer));
      }
      for (let name of getOwnPropertySymbols(obj)) {
        let desc = getOwnPropertyDescriptor(obj, name);
        let { get, set, value } = desc;
        status &= (get || set ? 0 : 3) & (shallow ? 1 : validate(value, transfer));
      }

      if (transfer) {
        if (getPrototypeOf(obj) !== null) {
          setPrototypeOf(obj, null);
        }
        if (!isFrozen(obj)) freeze(obj);
        if (!shallow || status === 3) {
          cache.add(obj);
        }
      }

      return status;
    };

let fastFreezeRecord = (obj) => {
  if (getPrototypeOf(obj) !== null) setPrototypeOf(obj, null);
  if (!isFrozen(obj)) freeze(obj);
  return obj;
};

let fastDeepFreezeRecord = (obj) => {
  if (!isObjecty(obj) || cache.has(obj)) return obj;
  fastFreezeRecord(obj);
  cache.add(obj);
  for (let name of getOwnPropertyNames(obj)) fastDeepFreezeRecord(obj[name]);
  for (let name of getOwnPropertySymbols(obj)) fastDeepFreezeRecord(obj[name]);
  return obj;
};

let deepFreezeRecord = preimplemented
  ? deepFreezeRecord_
  : !strict
  ? fastDeepFreezeRecord
  : (obj) => {
      let result = validate(obj, true);
      if (result < 3) throw new Error();
      return obj;
    };
let isDeepRecord = preimplemented ? isDeepRecord_ : !strict ? () => true : (obj) => validate(obj) >= 3;

if (!isSealed(Object) && !preimplemented) {
  Object.deepFreezeRecord = deepFreezeRecord_
    ? (obj) => (deepFreezeRecord(obj), deepFreezeRecord_(obj))
    : deepFreezeRecord;

  Object.isDeepRecord = isDeepRecord_
    ? (obj) => isDeepRecord_(obj) || isDeepRecord(obj)
    : isDeepRecord;
}

let isRecord = !strict
  ? () => true
  : (obj) => {
      return validate(obj, false, true) >= 1;
    };

let freezeRecord = !strict
  ? fastFreezeRecord
  : (obj) => {
      let result = validate(obj, true, true);
      if (result < 1) throw new Error();
      return obj;
    };

function* recordKeys(obj) {
  if (!isRecord(obj)) throw new Error();

  if (isArray(obj)) {
    let { length } = obj;
    for (let i = 0; i < length; i++) yield i;
  } else {
    for (let key in obj) yield key;
  }
}

function* recordValues(obj) {
  if (!isRecord(obj)) throw new Error();

  if (isArray(obj)) {
    let { length } = obj;
    for (let i = 0; i < length; i++) yield obj[i];
  } else {
    for (let key in obj) yield obj[key];
  }
}

function* recordEntries(obj) {
  if (!isRecord(obj)) throw new Error();

  if (isArray(obj)) {
    let { length } = obj;
    for (let i = 0; i < length; i++) yield [i, obj[i]];
  } else {
    for (let key in obj) yield [key, obj[key]];
  }
}

function* arrayKeys(obj) {
  let { length } = obj;
  for (let i = 0; i < length; i++) yield i;
}

function* arrayValues(obj) {
  let { length } = obj;
  for (let i = 0; i < length; i++) yield obj[i];
}

function* arrayEntries(obj) {
  let { length } = obj;
  for (let i = 0; i < length; i++) yield [i, obj[i]];
}

export {
  freezeRecord,
  isRecord,
  deepFreezeRecord,
  isDeepRecord,
  recordKeys,
  recordValues,
  recordEntries,
  arrayKeys,
  arrayValues,
  arrayEntries,
};
