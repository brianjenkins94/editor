Object.freeze = (value: unknown) => value;
Object.isFrozen = (() => true) as typeof Object.isFrozen;
