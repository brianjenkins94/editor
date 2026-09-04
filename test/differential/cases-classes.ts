/**
 * S2 class differential corpus. Each program's expected observable effects come from Node.
 */
export const CLASS_CASES: string[] = [
	`class A { constructor(x) { this.x = x; } get() { return this.x; } } new A(5).get()`,
	`class A { x = 10; y = 20; sum() { return this.x + this.y; } } new A().sum()`,
	`class A { field = 1; constructor() { this.field += 10; } } new A().field`,
	`class Counter { n = 0; inc() { this.n++; return this.n; } } const c = new Counter(); c.inc(); c.inc(); c.inc()`,
	`class A { static make() { return 42; } } A.make()`,
	`class A { static count = 7; static bump() { return ++A.count; } } A.bump() + A.count`,
	`class A { #n = 3; getN() { return this.#n; } } new A().getN()`,
	`class A { get val() { return 99; } } new A().val`,
	`class A { constructor() { this._v = 0; } set val(v) { this._v = v; } get val() { return this._v; } } const a = new A(); a.val = 5; a.val`,

	// inheritance
	`class Animal { constructor(n) { this.n = n; } speak() { return this.n + " noise"; } } class Dog extends Animal { speak() { return this.n + " woof"; } } new Dog("Rex").speak()`,
	`class A { constructor(x) { this.x = x; } } class B extends A { constructor(x, y) { super(x); this.y = y; } sum() { return this.x + this.y; } } new B(3, 4).sum()`,
	`class A { m() { return 1; } } class B extends A { m() { return super.m() + 10; } } new B().m()`,
	`class A { greet() { return "hi"; } } class B extends A {} new B().greet()`,
	`class Base { constructor() { this.tag = "base"; } } class Mid extends Base { constructor() { super(); this.tag += "-mid"; } } class Leaf extends Mid { constructor() { super(); this.tag += "-leaf"; } } new Leaf().tag`,
	`class A { constructor() { this.v = "a"; } } class B extends A { v2 = "b"; constructor() { super(); this.v2 = this.v + this.v2; } } new B().v2`,

	// instanceof / methods returning this / toString
	`class Point { constructor(x, y) { this.x = x; this.y = y; } toString() { return "(" + this.x + "," + this.y + ")"; } } String(new Point(1, 2))`,
	`class A {} const a = new A(); a instanceof A`,
	`class A {} class B extends A {} new B() instanceof A`,
	`class C { constructor() { this.items = []; } add(x) { this.items.push(x); return this; } } const c = new C(); c.add(1).add(2).add(3); c.items.length`,
	`class Stack { items = []; push(x) { this.items.push(x); return this; } pop() { return this.items.pop(); } get size() { return this.items.length; } } const s = new Stack(); s.push(1).push(2); s.pop() + s.size`,

	// class expression
	`const C = class { hello() { return "hey"; } }; new C().hello()`,
	`const makeClass = (base) => class extends base { extra() { return 1; } }; const K = makeClass(class { core() { return 2; } }); const k = new K(); k.extra() + k.core()`,
];
