// @brianjenkins94/bablr-language-ts — our BABLR grammar for the modern-TypeScript subset that ../tsval
// interprets, producing a lossless CSTML tree (the annotation substrate for the capability IDE).
//
// APPROACH (see KICKOFF.md / PROGRESS.md): EXTEND the upstream modern-JS grammar and add only the erasable-TS
// layer — type annotations, interface / type-alias / enum, generics, `as`/`satisfies`, `declare`. The JS core is
// inherited. Everything extends ONE imported base (`ESNext`) so forking the JS chain = repointing that import.
//
// Structure (mirrors how every es-layer upstream is built): productions live on a class that extends the base's
// UN-enhanced class (`ESNext.atrivial`), and the export is that class wrapped by `triviaEnhancer`, which is what
// makes whitespace/comments legal between the tokens our productions eat. (A plain `class X extends ESNext {}`
// only works while it adds no productions of its own.)
//
// Conventions learned from the base (each verified by round-trip):
//   - a production called as `<_Name />` is a COVER: whatever node it eats stands in its place. A cover may not
//     own fields, and may only shift by RETURNING `r(shiftMatch(...))`. A field whose matcher is a cover needs the
//     `+` flag (`type+$: <_Type />`); tokens use `*`, nodes `$`, arrays `[]`.
//   - infix/postfix forms are parsed by SHIFTING: a cover eats a primary, then `return r(shiftMatch(<_Cover />))`
//     re-enters itself with `s().shifted` set; the shifted branch eats a node whose first field is
//     `left+$: <_Cover />` with `o({ held: 'eat' })`, adopting the already-parsed node.
//   - inside the m`` DSL a `<` in a REGEX reads as a tag delimiter and `\x3c`/`\u003c` escapes are not
//     supported by the regex VM: test for `<` with a quoted literal match (`match(m`'<'`)`) instead.
//   - upstream productions are extended by INTERCEPTION (iterate `super.X(args)`, forward each instruction, inject
//     ours before/after a named field) so the JS core is not copied.
// ╔══════════════════════════════════════════════════════════════════════════════════════════════════════════╗
// ║ UPSTREAM-WORKAROUND index — code below that exists because of how the BABLR runtime behaves, not because the ║
// ║ language needs it. Each site is tagged `UPSTREAM-WORKAROUND(Wn)`; grep the tag. Details: UPSTREAM_BUGS.md.  ║
// ║                                                                                                             ║
// ║ W1  a span guard cuts every match at the guard character, including inside a token. The intended pattern (the ║
// ║     one strings and comments use) is that a token containing an enclosing guard character opens its own span. ║
// ║     Sites: Identifier/PrivateIdentifier (`\u{6F}` inside a `}`-guarded block) and, where a whole list contains ║
// ║     such tokens, unguarded spans with explicit close checks: TupleType (`T[]`), TypeArguments/TypeParameters/ ║
// ║     TypeAssertion (`=>`); ArrayType eats `[]` as one token. A runtime patch that moved guards to match      ║
// ║     boundaries was tried and dropped 2026-09-06: it was our design, not upstream's, and the grammar must work ║
// ║     on stock packages (patches/ apply only in this repo).                                                   ║
// ║ W2  guard regexes are tested at the current position without the preceding character, so a leading `\b` is  ║
// ║     always true and `\bof` fires inside `typeof`. Site: For (expression init). Known refusal:               ║
// ║     `for (i = typeof x; ;)`.                                                                                ║
// ║ W3  no longer applies: the regex lookahead it guarded went away with the W4 change.                         ║
// ║ W4  CLOSED in the grammar: the failed speculative call could not backtrack only because CallExpression's    ║
// ║     `eatMatch(<TypeArguments '<' />)` COMMITTED (a node literal skips the branch — W6 in UPSTREAM_BUGS.md). It is ║
// ║     `if (match('<')) eat(<TypeArguments />)` now and `f<T>(x)` vs `a < b` is decided by parsing.            ║
// ║ W5  perf: record validation is ~25% of parse time. Off in THIS repo via patches/@bablr+record (opt back in with ║
// ║     `globalThis[Symbol.for('@bablr/record:strict')] = true`); stock speed everywhere else.                  ║
// ║                                                                                                             ║
// ║ RUNTIME PATCHES (patches/, this repo only; consumers get stock packages and lose exactly these inputs):     ║
// ║ U1  astral characters (regex-vm `fromCharCode` truncation + bablr-vm UTF-16 `getSourceLength`).             ║
// ║ U2  empty input (the root cover `<_>` has no production name, so `emptyables` never applies to it).         ║
// ╚══════════════════════════════════════════════════════════════════════════════════════════════════════════╝
import * as BListKeyed from "@bablr/agast-helpers/b-map";
import { arrayValues } from "@bablr/agast-helpers/iterable";
import { freezeClass, freezeRecord } from "@bablr/agast-helpers/object";
import { getRoot as getPathRoot } from "@bablr/agast-helpers/path";
import { TreeNode } from "@bablr/agast-helpers/symbols";
import { get, getRoot, parseObject, printSource, printString, printTag } from "@bablr/agast-helpers/tree";
import { buildEmbeddedStringMatcher } from "@bablr/agast-vm-helpers/builders";
import {
	defineAttribute,
	eat,
	eatMatch,
	endSpan,
	fail,
	getInstrMatcher,
	m,
	match,
	o,
	r,
	shift,
	shiftMatch,
	startSpan,
	startSubspan
} from "@bablr/helpers/grammar";
import { triviaEnhancer } from "@bablr/helpers/trivia";
import ESNext from "@bablr/language-en-esnext";

export * from "@bablr/language-en-esnext";

export const canonicalURL = "https://bablr.org/languages/brianjenkins94/ts";

const keywordTypes = /(?:any|unknown|never|void|null|undefined|string|number|boolean|bigint|symbol|object|this)\b/;

// `m` from a plain string (the template form cannot spell a `<` in a regex; `\<` is the DSL's escape for it).
export const mRaw = (source) => m(Object.assign([source], { "raw": [source] }));

// ── identifiers ─────────────────────────────────────────────────────────────────────────────────────────────
// Strict-mode + module reserved words (es5's list also reserves `arguments`/`eval`, which are legal binding names).
const reservedWords = new Set(
	"break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public".split(
		" "
	)
);
// Non-ASCII identifier characters, approximated as "everything above ASCII except Unicode whitespace". BMP ranges are
// spelled with raw characters (the DSL regex lexer indexes patterns by UTF-16 unit, so a raw astral char cannot be
// lexed); the astral plane uses the DSL's `\u{...}` escape. Astral chars reach the matcher as single code points only
// with the patched runtime (UPSTREAM_BUGS.md U1, `patches/`): unpatched, every astral char fails long before this.
const ch = (code) => String.fromCharCode(code);
const nonAsciiIdChars = [
	[0xAA, 0x1FFF],
	[0x200C, 0x2027],
	[0x202A, 0x2FFF],
	[0x3001, 0xFEFE],
	[0xFF00, 0xFFFF]
]
	.map(([lo, hi]) => ch(lo) + "-" + ch(hi))
	.join("");
// `\\u` in the DSL is an escaped backslash followed by `u` (a bare `\u` would be the DSL's own escape).
const idEscape = "\\\\u(?:[0-9a-fA-F]{4}|\\{[0-9a-fA-F]+\\})";
const astralIdChars = "\\u{10000}-\\u{10FFFF}";
const identifierPattern = `(?:[a-zA-Z_$${nonAsciiIdChars}${astralIdChars}]|${idEscape})(?:[a-zA-Z0-9_$${nonAsciiIdChars}${astralIdChars}]|${idEscape})*`;
const identifierMatcher = mRaw(`/${identifierPattern}/`);
const privateIdentifierMatcher = mRaw(`/#${identifierPattern}/`);
const escapables = freezeRecord({ "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t", "v": "\v", "0": "\0" });
const lineContinuationMatcher = mRaw(`code*: <*LineContinuation /\\r\\n|[\\n\\r${ch(0x2028)}${ch(0x2029)}]/ />`);
const bomLookahead = mRaw(`/${ch(0xFEFF)}/`);
const bomMatcher = mRaw(`bomToken*: <* '${ch(0xFEFF)}' />`);

// ── operators ───────────────────────────────────────────────────────────────────────────────────────────────
// Binding powers follow es3 (comma 16 … access 0); `**` sits between `*` (5) and unary (4) and is right-associative.
const binaryPowers = freezeRecord({
	"??": 14,
	"||": 14,
	"&&": 13,
	"|": 12,
	"^": 11,
	"&": 10,
	"===": 9,
	"==": 9,
	"!==": 9,
	"!=": 9,
	"<=": 8,
	"<": 8,
	">=": 8,
	">": 8,
	"instanceof": 8,
	"in": 8,
	">>>": 7,
	"<<": 7,
	">>": 7,
	"+": 6,
	"-": 6,
	"%": 5,
	"*": 5,
	"/": 5,
	"**": 4.5
});
const assignmentOperators = new Set(["=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", ">>>=", "&=", "^=", "|=", "**=", "&&=", "||=", "??="]);
// Every infix/postfix operator, longest first (the base lists `<` before `<<`, which is why `1 << 0` fails there).
const operatorMatcher = m`/>>>=|\*\*=|<<=|>>=|>>>|===|!==|&&=|\|\|=|\?\?=|\*\*|<<|>>|<=|>=|==|!=|&&|\|\||\?\?|\?\.|\+=|-=|\*=|\/=|%=|&=|\^=|\|=|\+\+|--|[-+*\/%&|^<>=!?,.[(]|(?:instanceof|in|as|satisfies)\b/`;
const sigilMatchers = new Map();

function sigilMatcher(field, op) {
	const key = field + " " + op;
	let matcher = sigilMatchers.get(key);

	if (!matcher) {
		sigilMatchers.set(key, (matcher = mRaw(`${field}*: <*${/^[a-z]/.test(op) ? "Keyword" : ""} ${JSON.stringify(op)} />`)));
	}

	return matcher;
}

const assignableTypes = new Set(["Identifier", "MemberExpression", "Array", "Object", "NonNullExpression", "ParenthesisExpression"]);

// Whitespace beyond space/tab/newline (NBSP, BOM, line/paragraph separators, ...), which the base's Space language
// does not know; these regexes are built from code points so this file stays ASCII.
const unicodeSpaceChars = [0x0B, 0x0C, 0xA0, 0x1680, 0x202F, 0x205F, 0x3000, 0xFEFF, 0x2028, 0x2029].map(ch).join("") + ch(0x2000) + "-" + ch(0x200A);
const unicodeSpaceMatcher = mRaw(`.: <*UnicodeSpace /[${unicodeSpaceChars}]+/ />`);
const triviaStartMatcher = mRaw(`/\\/\\/|\\/\\*|[ \\t][^ \\t\\r\\n\\g/]|[ \\n\\r\\t${unicodeSpaceChars}]/`);

// Type precedence, highest binding first: postfix (`T[]`, `T[K]`) < prefix operators (`keyof T`) < `&` < `|`.
const typePowers = freezeRecord({ "postfix": 0, "operator": 1, "intersection": 2, "union": 3, "conditional": 4 });
const BT = ch(0x60);
const typeSigilMatcher = mRaw(`/[(\\[{'"\\d<|&${BT}-]|(?:typeof|keyof|readonly|unique|new|abstract|infer|true|false)\\b/`);
const templateOpenMatcher = mRaw(`openToken*: <* '${BT}' />`);
const templateCloseMatcher = mRaw(`closeToken*: <* '${BT}' />`);
const typeInterpolationMatcher = mRaw(`interpolations[]$: <TypeInterpolation '\${' />`);
const typeInterpolationOpenMatcher = mRaw(`openToken*: <* '\${' />`);
const mappedTypeLookahead = m`/\{[ \t\r\n]*(?:[+-]?readonly[ \t]+)?\[[a-zA-Z_$][a-zA-Z\d_$]*[ \t]+in\b/`;
const typePredicateLookahead = m`/(?:asserts[ \t]+)?(?:this|[a-zA-Z_$][a-zA-Z\d_$]*)[ \t]+is[ \t]|asserts[ \t]+(?:this\b|[a-zA-Z_$])/`;

// Forward every instruction of an inherited production, injecting ours before/after the named fields.
function *intercept(iter, { first, before = {}, after = {}, replace = {} }) {
	let step = iter.next();

	if (first && !step.done) {
		yield* first();
	}

	while (!step.done) {
		const instr = step.value;
		const refName = getInstrMatcher(instr)?.reference?.value?.name;

		if (refName && before[refName]) {
			yield* before[refName]();
		}

		const res = refName && replace[refName] ? yield* replace[refName](instr) : yield instr;

		if (refName && after[refName]) {
			yield* after[refName]();
		}

		step = iter.next(res);
	}

	return step.value;
}

// `<T extends U = D, ...>` before the params, `: R` after them — shared by every function-like production.
// A type parameter list starts with an identifier or a `const`/`in`/`out` modifier: `<(` and `<{` can only be a type
// assertion. The lookahead keeps a failing TypeParameters attempt (whose leaked span + source position let the
// inherited arrow carry on from inside it) from ever starting.
const typeParametersLookahead = mRaw(`/<[ \\t\\r\\n]*(?:(?:const|in|out)[ \\t]+)*(?:${identifierPattern})/`);

function *typeParametersHook() {
	if (yield match(typeParametersLookahead)) {
		yield eatMatch(m`typeParameters$: <TypeParameters '<' />`);
	}
}

function *returnTypeHook() {
	yield eatMatch(m`returnType$: <TypeAnnotation ':' />`);
}

const signatureHooks = freezeRecord({
	"before": freezeRecord({ "openParamsToken": typeParametersHook }),
	"after": freezeRecord({ "closeParamsToken": returnTypeHook })
});

// `function f(): void;` — an overload or ambient declaration has no body
function *optionalBodyHook(instr) {
	if (yield match(m`'{'`)) {
		return yield instr;
	}

	return yield eat(m`body$: null`);
}

const declarationHooks = freezeRecord({
	"before": signatureHooks.before,
	"after": signatureHooks.after,
	"replace": freezeRecord({ "body": optionalBodyHook })
});

// arrows decide `(` vs bare param with their very first instruction, so type params must come before it
function *asyncAndTypeParametersHook() {
	if (!(yield match(m`/async[ \t]*=>/`))) {
		yield eatMatch(m`asyncToken*: <*Keyword 'async' />`);
	}

	yield* typeParametersHook();
}

const arrowHooks = freezeRecord({
	"first": asyncAndTypeParametersHook,
	"after": freezeRecord({ "closeParamsToken": returnTypeHook })
});

// `(a: T, b?: U, ...rest: V[])` — the parameter list of function types and signatures (types only; the runtime
// function productions are inherited and get their annotations through CapturePattern → Parameter).
// `(a, ...b, c)` — call/new arguments (after the open paren, before the close paren)
function *argumentList() {
	yield startSpan("Bare", ")");
	let sep = true;

	while (sep && !(yield match(m`/$/`))) {
		yield startSubspan(null, ",");
		if (yield match(m`'...'`)) {
			yield eat(m`arguments[]+$: <SpreadElement />`);
		} else {
			yield eat(m`arguments[]+$: <_Expression />`);
		}

		yield endSpan();
		sep = yield eatMatch(m`#separatorTokens: <* ',' />`);
	}

	yield endSpan();
}

// TS parameter properties: an accessibility / readonly modifier (one or more) before a constructor
// parameter's binding, e.g. `constructor(public readonly x: T)`. Valid only in constructors, but the CST
// accepts them in any parameter list — semantic placement isn't the parser's concern. The lookahead
// requires a binding-start (or another modifier) after the keyword so a param literally NAMED `readonly`
// or `override` (both contextual, not reserved) — `f(readonly: T)` — is not mistaken for a modifier.
const paramPropertyModifier = /(?:public|private|protected|readonly|override)\b/;
const paramPropertyLookahead = mRaw(`/(?:public|private|protected|readonly|override)[ \\t]+(?:public|private|protected|readonly|override|this\\b|#?${identifierPattern}|[[{])/`);

export function *parameterList() {
	yield eat(m`openParamsToken*: <* '(' />`);
	yield startSpan("Bare", ")");
	let sep = true;

	while (sep && !(yield match(m`/$/`))) {
		if (yield match(m`'...'`)) {
			yield eat(m`params[]+$: <SpreadPattern />`);
		} else if (yield match(paramPropertyLookahead)) {
			// A TS parameter property (`public x: T`) — parse a Parameter directly so the modifiers attach to
			// it; the CapturePattern cover can't start on a modifier keyword.
			yield eat(m`params[]+$: <Parameter />`);
		} else {
			yield eat(m`params[]+$: <_CapturePattern />`);
		}

		sep = yield eatMatch(m`#separatorTokens: <* ',' />`);
	}

	yield endSpan();
	yield eat(m`closeParamsToken*: <* ')' />`);
}

// ASI support data (es3's statement mixin): statements that need no `;` before the next one on the same line.
const noSemiStatements = [
	"Switch",
	"Block",
	"DoWhile",
	"EmptyStatement",
	"TryCatch",
	"FunctionDeclaration",
	"ClassDeclaration",
	"InterfaceDeclaration",
	"EnumDeclaration"
];
const blockSemiStatements = ["DoWhile", "While", "For", "If"];

// Class member modifiers count as modifiers only when a member name (or another modifier) follows on the same
// line — otherwise they are the member's name (`static = 1`, `public() {}`).
const classModifier = /(?:public|private|protected|static|readonly|abstract|override|declare)\b/;
const memberStart = `(?:${identifierPattern}|[#'"\\[\\d*.])`;
const classModifierLookahead = mRaw(`/(?:public|private|protected|static|readonly|abstract|override|declare)[ \\t]+${memberStart}/`);
const accessorLookahead = mRaw(`/(?:get|set)[ \\t]+${memberStart}/`);
const asyncMemberLookahead = mRaw(`/async[ \\t]+${memberStart}/`);

// method = [modifiers] [get|set|async] [*] name [?] followed by `(` — or by `<` (generic), which the DSL cannot
// spell inside a regex, so the range `[;-<]` (";" and "<") is used and the `;` false positive is filtered by a
// backtracking eatMatch.
const memberPrefix = `(?:(?:public|private|protected|static|readonly|abstract|override|declare|async|get|set)[ \\t]+)*\\*?[ \\t]*(?:#?${identifierPattern}|'[^']*'|"[^"]*"|\\d[a-zA-Z0-9_.]*|\\.\\d+|\\[(?:[^\\[\\]]|\\[[^\\]]*\\])*\\])[ \\t]*\\??[ \\t]*`;

export const classMethodLookahead = mRaw(`/${memberPrefix}\\(/`);
const classGenericMethodLookahead = mRaw(`/${memberPrefix}\\</`);

export function *classMemberHead() {
	while (yield match(classModifierLookahead)) {
		yield eat(m`modifiers[]*: <*Keyword ${classModifier} />`);
	}
}

// `name`, `#name`, `'name'`, `0`, `[computed]` (field names follow es2022's ClassMethod/ClassProperty)
export function *classMemberName() {
	if (yield eatMatch(m`openNameToken*: <* '[' />`)) {
		yield startSpan("Bare", "]");
		yield eat(m`name+$: <_Expression />`);
		yield endSpan();
		yield eat(m`closeNameToken*: <* ']' />`);
	} else if (yield eatMatch(m`name$: <*PrivateIdentifier '#' />`)) {
		// consumed by the match in the condition; nothing more to eat
	} else if (yield eatMatch(m`name$: <String /['"]/ />`)) {
		// consumed by the match in the condition; nothing more to eat
	} else if (yield eatMatch(m`name$: <Number /[\d.]/ />`)) {
		// consumed by the match in the condition; nothing more to eat
	} else {
		yield eat(m`name$: <*Identifier />`, o({ "scoped": false }));
	}
}

// `extends Base<T> implements A, B`
function *classHeritage() {
	if (yield eatMatch(m`extendsToken*: <*Keyword 'extends' />`)) {
		yield eat(m`superClass+$: <_Expression />`, o({ "power": 2 }));
		yield eatMatch(m`superTypeArguments$: <TypeArguments '<' />`);
	} else {
		yield eat(m`superClass+$: null`);
	}

	if (yield eatMatch(m`implementsToken*: <*Keyword 'implements' />`)) {
		let sep = true;

		while (sep) {
			yield eat(m`implements[]$: <TypeReference />`);
			sep = yield eatMatch(m`#separatorTokens: <* ',' />`);
		}
	}
}

export class TypeScriptAtrivial extends ESNext.atrivial {
  // `[a, b] = x` / `({ a } = x)`: array and object literals are assignment targets too.
	public static context = freezeRecord({
		...super.context,
		"assignables": freezeRecord([...arrayValues(super.context.assignables), "Array", "Object"])
	});

	public static canonicalURL = canonicalURL;

	public constructor() {
		super();
    // `endsWithBlock`: set by If/For/While so the statement list can allow `if (a) {} b()` on one line
    // (the base's trailing-block lookup through the gap node never sees the Block).
		this.attributes = BListKeyed.concat(
			this.attributes || BListKeyed.create(),
			BListKeyed.from(
				BListKeyed.entry("If", { "endsWithBlock": undefined }),
				BListKeyed.entry("For", { "endsWithBlock": undefined }),
				BListKeyed.entry("While", { "endsWithBlock": undefined })
			)
		);
	}

  // ── statements: TS declarations ──────────────────────────────────────────────────────────────────────────

	public *Statement(args) {
		if (yield match(m`';'`)) {
			yield eat(m`<EmptyStatement />`);

			return;
		}

		if (yield match(m`/(?:import|export|class|var|const|let|async)[a-zA-Z0-9_$]/`)) {
			yield eat(m`<ExpressionStatement />`);

			return;
		}

    // `async` starts a declaration only as `async function`; `async x => x`, `async (x) => x`, `async = 1` and a bare
    // `async` are expressions (the base's dispatch sends every `async` to the function declaration).
		if ((yield match(m`/async\b/`)) && !(yield match(m`/async[ \t]+function\b/`))) {
			yield eat(m`<ExpressionStatement />`);

			return;
		}

		const res = yield match(
			m`/interface\b|(?:const[ \t]+)?enum\b|abstract[ \t]+class\b|declare[ \t]+(?:const|let|var|function|class|abstract|enum|module|namespace|global|interface|type|async)\b|type[ \t]+[a-zA-Z_$][a-zA-Z\d_$]*[ \t]*[<=]/`
		);
		const word = res ? printSource(res).split(/[ \t]/)[0] : null;

		switch (word) {
			case "interface":
				yield eat(m`<InterfaceDeclaration />`);
				break;
			case "enum":
			case "const":
				yield eat(m`<EnumDeclaration />`);
				break;
			case "abstract":
				yield eat(m`<ClassDeclaration />`);
				break;
			case "declare":
				yield eat(m`<AmbientDeclaration />`);
				break;
			case "type":
				yield eat(m`<TypeAliasDeclaration />`);
				break;
			default:
				return yield* super.Statement(args);
		}
	}

	public *InterfaceDeclaration() {
		yield eat(m`sigilToken*: <*Keyword 'interface' />`);
		yield eat(m`name$: <*Identifier />`, o({ "scoped": false }));
		yield eatMatch(m`typeParameters$: <TypeParameters '<' />`);
		if (yield eatMatch(m`extendsToken*: <*Keyword 'extends' />`)) {
			let sep = true;

			while (sep) {
				yield eat(m`heritage[]$: <TypeReference />`);
				sep = yield eatMatch(m`#separatorTokens: <* ',' />`);
			}
		}

		yield eat(m`body$: <TypeLiteral />`);
	}

	public *TypeAliasDeclaration() {
		yield eat(m`sigilToken*: <*Keyword 'type' />`);
		yield eat(m`name$: <*Identifier />`, o({ "scoped": false }));
		yield eatMatch(m`typeParameters$: <TypeParameters '<' />`);
		yield eat(m`assignmentToken*: <* '=' />`);
		yield eat(m`type+$: <_Type />`);
	}

  // The one non-erasable construct tsval keeps (runtime emit).
	public *EnumDeclaration() {
		yield eatMatch(m`constToken*: <*Keyword 'const' />`);
		yield eat(m`sigilToken*: <*Keyword 'enum' />`);
		yield eat(m`name$: <*Identifier />`, o({ "scoped": false }));
		yield eat(m`openToken*: <* '{' />`);
		yield startSpan("Bare", "}");
		let sep = true;

		while (sep && !(yield match(m`/$/`))) {
			yield eat(m`members[]$: <EnumMember />`);
			sep = yield eatMatch(m`#separatorTokens: <* ',' />`);
		}

		yield endSpan();
		yield eat(m`closeToken*: <* '}' />`);
	}

	public *EnumMember() {
		yield eat(m`name+$: <_ObjectKey />`);
		if (yield eatMatch(m`assignmentToken*: <* '=' />`)) {
			yield startSubspan(null, ",");
			yield eat(m`value+$: <_Expression />`);
			yield endSpan();
		} else {
			yield eat(m`value+$: null`);
		}
	}

  // `declare const x: T;`, `declare function f(): T;`, `declare class C {}` — bodies are optional in there.
	public *AmbientDeclaration() {
		yield eat(m`declareToken*: <*Keyword 'declare' />`);
		yield eat(m`declaration+$: <_Statement />`);
	}

  // ── classes ──────────────────────────────────────────────────────────────────────────────────────────────

	public *ClassDeclaration() {
		yield eatMatch(m`abstractToken*: <*Keyword 'abstract' />`);
		yield eat(m`sigilToken*: <*Keyword 'class' />`);
		yield eat(m`name$: <*Identifier />`);
		yield eatMatch(m`typeParameters$: <TypeParameters '<' />`);
		yield* classHeritage();
		yield eat(m`body$: <ClassBody />`);
	}

	public *ClassExpression() {
		yield eatMatch(m`abstractToken*: <*Keyword 'abstract' />`);
		yield eat(m`sigilToken*: <*Keyword 'class' />`);
		yield eatMatch(m`name$: <*Identifier />`);
		yield eatMatch(m`typeParameters$: <TypeParameters '<' />`);
		yield* classHeritage();
		yield eat(m`body$: <ClassBody />`);
	}

  // Cover: one class element. Methods are tried first (they fail fast when no `(`/`<` follows the name).
	public *ClassMember() {
		if (yield match(m`';'`)) {
			yield eat(m`<EmptyMember />`);
		} else if (yield match(m`/static[ \t\r\n]*\{/`)) {
			yield eat(m`<ClassStaticBlock />`);
		} else if (yield match(m`/(?:(?:static|readonly)[ \t]+)*\[[a-zA-Z_$][a-zA-Z\d_$]*[ \t]*:/`)) {
			yield eat(m`<ClassIndexSignature />`);
		} else if (yield match(classMethodLookahead)) {
			yield eat(m`<ClassMethod />`);
		} else if ((yield match(classGenericMethodLookahead)) && (yield eatMatch(m`<ClassMethod />`))) {
			// consumed by the match in the condition; nothing more to eat
		} else {
			yield eat(m`<ClassProperty />`);
		}
	}

	public *EmptyMember() {
		yield eat(m`sigilToken*: <* ';' />`);
	}

	public *ClassIndexSignature() {
		yield* classMemberHead();
		yield eat(m`openToken*: <* '[' />`);
		yield eat(m`key$: <*Identifier />`, o({ "scoped": false }));
		yield eat(m`keyType$: <TypeAnnotation ':' />`);
		yield eat(m`closeToken*: <* ']' />`);
		yield eat(m`typeAnnotation$: <TypeAnnotation ':' />`);
		yield eatMatch(m`endToken*: <* ';' />`);
	}

	public *ClassMethod() {
		yield* classMemberHead();
		if (yield match(accessorLookahead)) {
			yield eat(m`kindToken*: <*Keyword /get|set/ />`);
		} else {
			if (yield match(asyncMemberLookahead)) {
				yield eat(m`asyncToken*: <*Keyword 'async' />`);
			}

			yield eatMatch(m`starToken*: <* '*' />`);
		}

		yield* classMemberName();
		yield eatMatch(m`optionalToken*: <* '?' />`);
		if (!((yield match(m`'('`)) || (yield match(m`'<'`)))) {
			yield fail();
		}

		yield eatMatch(m`typeParameters$: <TypeParameters '<' />`);
		yield* parameterList();
		yield eatMatch(m`returnType$: <TypeAnnotation ':' />`);
		if (!(yield eatMatch(m`body$: <Block '{' />`))) {
			yield eatMatch(m`endToken*: <* ';' />`);
		}
	}

	public *ClassProperty() {
		yield* classMemberHead();
		yield* classMemberName();
		yield eatMatch(m`optionalToken*: <* /[?!]/ />`);
		yield eatMatch(m`typeAnnotation$: <TypeAnnotation ':' />`);
		if (yield eatMatch(m`sigilToken*: <* '=' />`)) {
			yield eat(m`value+$: <_Expression />`);
		} else {
			yield eat(m`value+$: null`);
		}

		yield eatMatch(m`endToken*: <* ';' />`);
	}

  // es3's Keyword requires a delimiter after the word; TS adds `<`/`>` (`class<T>`, `extends B<T>`).
	public *Keyword({ literalValue, s }) {
		if (!literalValue) {
			throw new Error("Intrinsic productions must have value");
		}

		const word = printSource(literalValue);

		yield eat(buildEmbeddedStringMatcher(word));
		if (s().span.name !== "Escape" && /^[a-z]/i.test(word)) {
			if (!(yield match(m`/[ \n\r\t]|\/\/|\/\*|$|[*&^%$#@!?(){}[\].,/\\'";:=+|\u0061~-]|<|>/`))) {
				yield fail();
			}
		}
	}

	public *Hashbang() {
		yield eat(m`/#![^\r\n]*/`);
	}

	public *PrivateIdentifier() {
    // UPSTREAM-WORKAROUND(W1): same as Identifier.
		yield startSpan("Identifier");
		yield eat(privateIdentifierMatcher);
		yield endSpan();
	}

	public *Identifier({ "props": { scoped = true } }) {
    // UPSTREAM-WORKAROUND(W1): an escape like `\u{6F}` contains `}`, and a guard cuts the match at the guard
    // character; the token gets its own span, the way strings and comments do. No measurable cost.
		yield startSpan("Identifier");
		const id = printSource(yield eat(identifierMatcher));

		yield endSpan();
		if (scoped && reservedWords.has(id)) {
			yield fail();
		}
	}

  // A leading byte-order mark is part of the document.
	public *Program() {
		if (yield match(bomLookahead)) {
			yield eat(bomMatcher);
		}

		yield eatMatch(m`hashbangToken*: <*Hashbang '#!' />`);
		yield eat(m`body[]$: <__StatementList />`);
	}

  // ── statements (JS fixes) ────────────────────────────────────────────────────────────────────────────────
  // es3's StatementList, plus empty statements (`;;`, `while (x);`) as real `EmptyStatement` nodes.
	public *StatementList({ getState, ctx, matcher }) {
		const { getGapNode } = ctx;
		let chr, sep, stmt, trivia;
		let ran = false;

		for (;;) {
			chr = yield match(m`/[^\g]/s`);

			if (!chr && !(yield match(m`/\g/`))) {
				break;
			}

			ran = true;
			const isEmpty = chr && printSource(chr) === ";";

			stmt = isEmpty
				? yield eat(m`${printTag(matcher.value.reference)} <EmptyStatement />`)
				: yield eat(m`${printTag(matcher.value.reference)} <_Statement />`);

			const state = getState();

			if (state.held) {
				trivia = state.held;
			}

			sep = isEmpty ? null : yield eatMatch(m`#separatorTokens: <* ';' />`);

			const newline = Boolean(trivia) && printSource(trivia, { "getGapNode": getGapNode }).includes("\n");
			const stmtRoot = getPathRoot(stmt.node);
			const name = stmtRoot.type === TreeNode ? stmtRoot.value.name.description : null;
			const allowSameLine =
				isEmpty
				|| (stmtRoot.type === TreeNode
					&& (noSemiStatements.includes(name)
						|| (blockSemiStatements.includes(name) && stmtRoot.value.attributes?.endsWithBlock === true)));

			if (!allowSameLine && !(sep || newline)) {
				break;
			}
		}

		if (!ran) {
			yield eatMatch(m`#separatorTokens: <* ';' />`);
		}
	}

  // es3's Trivia plus Unicode whitespace.
	public *Trivia() {
		while (
			(yield eatMatch(m`.: :Space: <_Blank /[ \n\r\t]+/ />`))
			|| (yield eatMatch(m`.: :Comment: <_Comment /\/\/|\/\*/ />`))
			|| (yield eatMatch(unicodeSpaceMatcher))
		) {
			// consumed by the match in the condition; nothing more to eat
		}
	}

	public *UnicodeSpace() {
		yield eat(mRaw(`/[${unicodeSpaceChars}]+/`));
	}

	public *EmptyStatement() {
		yield eat(m`sigilToken*: <* ';' />`);
	}

  // es3's If, plus `if (a) b; else c` — the `;` that terminates the consequent belongs to the If.
	public *If() {
		yield eat(m`sigilToken*: <*Keyword 'if' />`);
		yield eat(m`openHeaderToken*: <* '(' />`);
		yield startSpan("Bare", ")");
		yield eat(m`test+$: <_Expression />`);
		yield endSpan();
		yield eat(m`closeHeaderToken*: <* ')' />`);
		let endsWithBlock = Boolean(yield match(m`'{'`));

		yield eat(m`consequent$: <_Statement />`, o({}), o({ "allowEmpty": false }));
		if (yield match(m`/;[ \t\r\n]*else\b/`)) {
			yield eat(m`consequentTerminatorToken*: <* ';' />`);
		}

		if (yield eatMatch(m`alternateSigilToken*: <*Keyword 'else' />`)) {
			endsWithBlock = Boolean(yield match(m`'{'`));
			yield eat(m`alternate$: <_Statement />`, o({}), o({ "allowEmpty": false }));
		} else {
			yield eat(m`alternate$: null`);
		}

		yield defineAttribute("endsWithBlock", endsWithBlock);
	}

  // es3's While plus the `endsWithBlock` attribute.
	public *While() {
		yield eat(m`sigilToken*: <*Keyword 'while' />`);
		yield eat(m`openHeaderToken*: <* '(' />`);
		yield startSpan("Bare", ")");
		yield eat(m`test+$: <_Expression />`);
		yield endSpan();
		yield eat(m`closeHeaderToken*: <* ')' />`);
		const endsWithBlock = Boolean(yield match(m`'{'`));

		yield eat(m`body$: <_Statement />`, o({ "allowEmpty": false }));
		yield defineAttribute("endsWithBlock", endsWithBlock);
	}

  // es6/es2018's For. The base guards the init subspan with `/;|of|in/`, which fires INSIDE names like `index`;
  // a `\b` does not help because span guards are tested at the current position without the preceding character
  // (`\bof` fires inside `typeof`). Only `;` is needed for declarations: `in` is excluded by `noIn` and `of` is
  // never an operator.
	public *For() {
		yield eat(m`sigilToken*: <*Keyword 'for' />`);
		yield eatMatch(m`awaitToken*: <*Keyword 'await' />`);
		yield eat(m`openHeaderToken*: <* '(' />`);
		yield startSpan("Bare", ")");
		yield startSubspan(null, ";");
		if (!(yield eatMatch(m`init+$: <VariableDeclaration />`))) {
      // UPSTREAM-WORKAROUND(W2) + G6: the init should stop at `in`/`of` because `noIn` says so, but the base's
      // Expression drops `noIn` when it shifts, so a guard does it; and because the guard is tested without the
      // preceding character, `\bof\b` fires inside `typeof` (`for (i = typeof x; ;)` is wrongly refused). Delete
      // the subspan once `noIn` survives shifting.
			yield startSubspan(null, m`/;|\bin\b|\bof\b/`);
			yield eatMatch(m`init+$: <_Expression />`, o({ "noIn": true }));
			yield endSpan();
		}

		yield endSpan();
		const source = yield eatMatch(m`inToken*: <*Keyword /in|of/ />`);

		if (source) {
			yield eatMatch(m`source+$: <_Expression />`);
		} else {
			yield eat(m`testSeparatorToken*: <* ';' />`);
			yield startSpan("Bare", ";");
			yield eatMatch(m`test+$: <_Expression />`);
			yield endSpan();
			yield eat(m`updateSeparatorToken*: <* ';' />`);
			yield eatMatch(m`update+$: <_Expression />`);
		}

		yield endSpan();
		yield eat(m`closeHeaderToken*: <* ')' />`);
		const endsWithBlock = Boolean(yield match(m`'{'`));

		yield eat(m`body*: <_Statement />`);
		yield defineAttribute("endsWithBlock", endsWithBlock);
	}

  // es3's Catch with a destructuring/annotated parameter and the optional binding (`catch {`).
	public *Catch() {
		yield eat(m`sigilToken*: <*Keyword 'catch' />`);
		if (yield eatMatch(m`openArgumentsToken*: <* '(' />`)) {
			yield startSpan("Bare", ")");
			yield eat(m`params[]+$: <_CapturePattern />`);
			yield endSpan();
			yield eat(m`closeArgumentsToken*: <* ')' />`);
		}

		yield eat(m`body$: <Block />`);
	}

  // ── literals (JS fixes) ──────────────────────────────────────────────────────────────────────────────────
  // es6's ArrayElement plus elisions (`[, , x]`).
	public *ArrayElement() {
		if (yield match(m`','`)) {
			yield eat(m`value+$: null`);
			yield eat(m`separatorToken*: <* ',' />`);
		} else if (yield match(m`'...'`)) {
			yield eat(m`value+$: <SpreadElement />`);
			yield eatMatch(m`separatorToken*: <* ',' />`);
		} else {
			yield startSubspan(null, ",");
			yield eat(m`value+$: <_Expression />`);
			yield endSpan();
			yield eatMatch(m`separatorToken*: <* ',' />`);
		}
	}

  // es6's SpreadElement inside its own `,` subspan (otherwise `...a, b` continues into a sequence expression).
	public *SpreadElement() {
		yield eat(m`sigilToken*: <* '...' />`);
		yield startSubspan(null, ",");
		yield eat(m`value+$: <_Expression />`);
		yield endSpan();
	}

  // es2018's ObjectPattern with the rest element as a binding (`SpreadPattern`), not an expression.
	public *ObjectPattern() {
		yield eat(m`openToken*: <* '{' />`);
		yield startSpan("Bare", "}");
		let sep = true;

		while (sep && !(yield match(m`'...'`)) && !(yield match(m`/$/`))) {
			yield eat(m`params[]+$: <PropertyPattern />`);
			sep = yield eatMatch(m`#separatorTokens: <* ',' />`);
		}

		if (yield eatMatch(m`params[]+$: <SpreadPattern '...' />`)) {
			yield eatMatch(m`#separatorTokens: <* ',' />`);
		}

		yield endSpan();
		yield eat(m`closeToken*: <* '}' />`);
	}

  // Object keys: strings, any numeric literal (`1.0`, `0x10`, `.1`), computed, identifiers.
	public *ObjectKey() {
		if (yield eatMatch(m`<String /['"]/ />`)) {
			// consumed by the match in the condition; nothing more to eat
		} else if (yield eatMatch(m`<Number /[\d.]/ />`)) {
			// consumed by the match in the condition; nothing more to eat
		} else if (yield eatMatch(m`<ComputedObjectKey '[' />`)) {
			// consumed by the match in the condition; nothing more to eat
		} else {
			yield eat(m`<*Identifier />`, o({ "scoped": false }));
		}
	}

  // `{ a = 1 }` — only meaningful as an assignment pattern, but part of the language.
	public *CoverInitializedName() {
		yield eat(m`key+$: <_ObjectKey />`, o({}), o({ "held": "eat" }));
		yield eat(m`assignmentToken*: <* '=' />`);
		yield startSubspan(null, ",");
		yield eat(m`value+$: <_Expression />`);
		yield endSpan();
	}

  // String/template escapes: es3 accepts only a fixed set; JS allows `\x..`, `\u....`, `\u{...}`, line
  // continuations and identity escapes (`\d` → `d`). `cooked` is kept as an attribute like upstream.
	public *EscapeSequence({ s }) {
		const { span } = s();

		if (!span.name.startsWith("String")) {
			yield fail();
		}

		yield startSpan("Escape");
		yield eat(m`sigilToken*: <* '\\' />`);
		let cooked;

		if (yield match(m`/[xu]/`)) {
			const code = yield eat(m`code*: <EscapeCode />`);
			const value = Number.parseInt(printSource(get("value", code.node)), 16);

			cooked = value <= 0x10FFFF ? String.fromCodePoint(value) : "";
		} else if (yield eatMatch(lineContinuationMatcher)) {
			cooked = "";
		} else {
			const chr = printSource(yield match(m`/[^]/`));

			yield eat(mRaw(`code*: <*Keyword ${printString(chr)} />`));
			cooked = escapables[chr] ?? chr;
		}

		yield endSpan();
		yield defineAttribute("cooked", cooked);
	}

	public *EscapeCode() {
		if (yield eatMatch(m`typeToken*: <*Keyword 'x' />`)) {
			yield eat(m`value*: <*HexDigits />`, o({ "length": 2 }));
		} else {
			yield eat(m`typeToken*: <*Keyword 'u' />`);
			if (yield eatMatch(m`openToken*: <* '{' />`)) {
				yield eat(m`value*: <*HexDigits />`);
				yield eat(m`closeToken*: <* '}' />`);
			} else {
				yield eat(m`value*: <*HexDigits />`, o({ "length": 4 }));
			}
		}
	}

	public *HexDigits({ "props": { length } }) {
		let matcher;

		if (length === 2) {
			matcher = m`/[0-9a-fA-F]{2}/`;
		} else if (length === 4) {
			matcher = m`/[0-9a-fA-F]{4}/`;
		} else {
			matcher = m`/[0-9a-fA-F]+/`;
		}

		yield eat(matcher);
	}

	public *LineContinuation() {
		yield eat(m`/\r\n|[\n\r]/`);
	}

  // `yield` with no operand
	public *YieldExpression() {
		yield eat(m`sigilToken*: <*Keyword 'yield' />`);
		yield eatMatch(m`starToken*: <* '*' />`);
		yield eatMatch(m`expression+$: <_Expression />`);
	}

  // ── numbers ──────────────────────────────────────────────────────────────────────────────────────────────
  // es3's Number plus radix prefixes, numeric separators, leading/trailing dots, exponents and BigInt.
	public *Number() {
		yield startSpan("Number");
		if (yield eatMatch(m`prefixToken*: <* /0[xXoObB]/ />`)) {
			yield eat(m`wholePart$: <*RadixDigits />`);
			yield eat(m`decimalPart$: null`);
			yield eat(m`exponentPart$: null`);
		} else {
			if (!(yield eatMatch(m`wholePart$: <*UnsignedInteger />`))) {
				yield eat(m`wholePart$: null`);
			}

			if (yield eatMatch(m`fractionalSeparatorToken*: <* '.' />`)) {
				if (!(yield eatMatch(m`decimalPart$: <*UnsignedInteger />`))) {
					yield eat(m`decimalPart$: null`);
				}
			} else {
				yield eat(m`decimalPart$: null`);
			}

			if (yield eatMatch(m`exponentSeparatorToken*: <* /[eE]/ />`)) {
				yield eat(m`exponentPart$: <*SignedInteger />`);
			} else {
				yield eat(m`exponentPart$: null`);
			}
		}

		yield eatMatch(m`bigintToken*: <* 'n' />`);
		yield endSpan();
	}

	public *UnsignedInteger() {
		yield eat(m`/\d(?:_?\d)*/`);
	}

	public *SignedInteger() {
		yield eat(m`/[+-]?\d(?:_?\d)*/`);
	}

	public *RadixDigits() {
		yield eat(m`/[0-9a-fA-F](?:_?[0-9a-fA-F])*/`);
	}

  // es2020's MemberExpression plus private names: `o.#x`, `o?.#x`
	public *MemberExpression() {
		yield eat(m`object+$: <_Expression />`, o({}), o({ "held": "eat" }));

		const sigil = yield match(m`/\?\.|[[.]/`);

		switch (sigil ? printSource(sigil) : null) {
			case "?.": {
				yield eat(m`dotToken*: <* '?.' />`);
				if (yield eatMatch(m`openToken*: <* '[' />`)) {
					yield startSpan("Bare", "]");
					yield eat(m`property+$: <_Expression />`);
					yield endSpan();
					yield eat(m`closeToken*: <* ']' />`);
				} else if (yield eatMatch(m`property$: <*PrivateIdentifier '#' />`)) {
					// consumed by the match in the condition; nothing more to eat
				} else {
					yield eat(m`property+$: <*Identifier />`, o({ "scoped": false }));
				}

				break;
			}

			case ".": {
				yield eat(m`dotToken*: <* '.' />`);
				if (yield eatMatch(m`property$: <*PrivateIdentifier '#' />`)) {
					// consumed by the match in the condition; nothing more to eat
				} else {
					yield eat(m`property+$: <*Identifier />`, o({ "scoped": false }));
				}

				break;
			}

			case "[": {
				yield eat(m`openToken*: <* '[' />`);
				yield startSpan("Bare", "]");
				yield eat(m`property+$: <_Expression />`);
				yield endSpan();
				yield eat(m`closeToken*: <* ']' />`);
				break;
			}

			default:
				yield fail();
		}
	}

  // ── annotation sites ─────────────────────────────────────────────────────────────────────────────────────

	public *VariableDeclarator() {
		if (yield match(m`'{'`)) {
			yield eat(m`receiver*: <ObjectPattern />`);
		} else if (yield match(m`'['`)) {
			yield eat(m`receiver*: <ArrayPattern />`);
		} else {
			yield eat(m`receiver*: <*Identifier />`);
		}

		yield eatMatch(m`definiteToken*: <* '!' />`);
		yield eatMatch(m`typeAnnotation$: <TypeAnnotation ':' />`);

		if (yield match(m`'='`)) {
			yield eat(m`assignmentToken*: <* '=' />`);
			yield startSubspan(null, ",");
			yield eat(m`value+$: <_Expression />`);
			yield endSpan();
		} else {
			yield eat(m`value+$: null`);
		}
	}

  // A binding in parameter position may carry `?` and `: T`: it shifts into a `Parameter` node wrapping the
  // pattern, which in turn may shift into `AssignmentPattern` for a default (`a?: T = 1` is the TS order).
	public *CapturePattern() {
		let pn;

		if (yield match(m`'...'`)) {
			yield eat(m`<SpreadPattern />`);
		} else {
			pn = yield match(m`/[[{]/`);

			if (pn) {
				switch (printSource(pn).trim()) {
					case "{":
						yield eat(m`<ObjectPattern />`);
						break;
					case "[":
						yield eat(m`<ArrayPattern />`);
						break;
					// no default
				}
			} else if (yield match(m`/this\b/`)) {
				yield eat(m`<*Keyword 'this' />`);
			} else {
				yield eat(m`<*Identifier />`);
			}
		}

		if (yield match(m`/[?:]/`)) {
			return r(shiftMatch(m`<Parameter />`));
		}

		return r(shiftMatch(m`<AssignmentPattern '=' />`));
	}

	public *Parameter({ s }) {
		if (s().shifted) {
			// Reached from the CapturePattern cover: the binding is already parsed and held, adopt it.
			yield eat(m`pattern+$: <_CapturePattern />`, o({}), o({ "held": "eat" }));
		} else {
			// Entered fresh from parameterList for a TS parameter property: eat its leading modifiers
			// (`public`/`private`/`protected`/`readonly`/`override`), then the binding DIRECTLY — not via the
			// `_CapturePattern` cover, which would shift into a nested Parameter on the `:` and steal the
			// typeAnnotation this production means to own.
			while (yield match(paramPropertyLookahead)) {
				yield eat(m`modifiers[]*: <*Keyword ${paramPropertyModifier} />`);
			}

			const open = yield match(m`/[[{]/`);

			if (open) {
				yield eat(printSource(open).trim() === "{" ? m`pattern$: <ObjectPattern />` : m`pattern$: <ArrayPattern />`);
			} else {
				yield eat(m`pattern$: <*Identifier />`);
			}
		}

		yield eatMatch(m`optionalToken*: <* '?' />`);
		yield eatMatch(m`typeAnnotation$: <TypeAnnotation ':' />`);

		return r(shiftMatch(m`<AssignmentPattern '=' />`));
	}

	public *SpreadPattern() {
		yield eat(m`sigilToken*: <* '...' />`);
		if (yield match(m`'['`)) {
			yield eat(m`value$: <ArrayPattern />`);
		} else if (yield match(m`'{'`)) {
			yield eat(m`value$: <ObjectPattern />`);
		} else {
			yield eat(m`value*: <*Identifier />`);
		}

		yield eatMatch(m`typeAnnotation$: <TypeAnnotation ':' />`);
	}

	public *FunctionExpression(args) {
		return yield* intercept(super.FunctionExpression(args), signatureHooks);
	}

	public *FunctionDeclaration(args) {
		return yield* intercept(super.FunctionDeclaration(args), declarationHooks);
	}

	public *ArrowFunctionExpression(args) {
		return yield* intercept(super.ArrowFunctionExpression(args), arrowHooks);
	}

  // `<T>(x: T) => x` starts with `<`, which the base's Expression does not dispatch on.
  // Primary forms the base's Expression does not dispatch on: `#x in o`, `<T>(x) => x`, `x => x`,
  // `async x => x` / `async (x) => x`, `.5`.
	public *Expression(args) {
		let res = null;

		if (!args.s().shifted) {
			if (yield match(m`'#'`)) {
				res = yield eat(m`<*PrivateIdentifier />`);
			} else if (yield match(m`'/'`)) {
				res = yield eat(m`<RegExpLiteral />`);
			} else if (yield match(m`/new[ \t]*\.[ \t]*target\b/`)) {
				res = yield eat(m`<MetaProperty />`);
			} else if (yield match(m`'<'`)) {
				res = yield eatMatch(m`<ArrowFunctionExpression />`);

				if (!res) {
					res = yield eat(m`<TypeAssertion />`);
				}
			} else if (yield match(m`/\.\d/`)) {
				res = yield eat(m`<Number />`);
			} else if (yield match(m`/await(?:[ \t]*[,;)\]}=.]|[ \t]*$)/`)) {
				res = yield eat(m`<*Identifier />`);
			} else if (yield match(m`/async[ \t]+function\b/`)) {
				res = yield eat(m`<FunctionExpression />`);
			} else if (yield match(m`/async[ \t]+[a-zA-Z_$(<]|async[ \t]*[(<]/`)) {
				res = yield eatMatch(m`<ArrowFunctionExpression />`);
			} else if (yield match(m`/[a-zA-Z_$][a-zA-Z\d_$]*[ \t]*=>/`)) {
				res = yield eat(m`<ArrowFunctionExpression />`);
			}
		}

		if (res) {
			if (!(yield match(m`/$/`))) {
				return r(shiftMatch(m`<_Expression />`, o({ "power": args.props.power })));
			}

			return;
		}

		return yield* super.Expression(args);
	}

  // Object-literal element (es6's, plus: `get`/`set` accessors and generic methods `m<T>() {}`).
	public *ObjectElement() {
		const asyncToken = yield match(m`'async'`);
		const starToken = yield match(m`'*'`);
		const accessor = yield match(accessorLookahead);
		const isMethod =
			starToken
			|| accessor
			|| (asyncToken && !(yield match(m`<All />`, freezeRecord([m`<* 'async' />`, m`<* /[(:]/ />`]))));

		if (isMethod) {
			yield eat(m`value+: <Method />`);
		} else if (yield eatMatch(m`value+: <SpreadElement '...' />`)) {
			// consumed by the match in the condition; nothing more to eat
		} else {
			yield eat(m`value+: <_ObjectKey />`);

			if (yield shiftMatch(m`<Property ':' />`)) {
				// consumed by the match in the condition; nothing more to eat
			} else if (yield shiftMatch(m`<Method '(' />`)) {
				// consumed by the match in the condition; nothing more to eat
			} else if ((yield match(m`'<'`)) && (yield shiftMatch(m`<Method />`))) {
				// consumed by the match in the condition; nothing more to eat
			} else if ((yield match(m`'='`)) && (yield shiftMatch(m`<CoverInitializedName />`))) {
				// consumed by the match in the condition; nothing more to eat
			} else {
				yield shift(m`<Property />`);
			}
		}

		yield eatMatch(m`separatorToken*: <* ',' />`);
	}

	public *Method(args) {
		if (yield match(accessorLookahead)) {
			yield eat(m`kindToken*: <*Keyword /get|set/ />`);
		}

		return yield* super.Method(args);
	}

  // ── regex literals ───────────────────────────────────────────────────────────────────────────────────────
  // One node with body and flags as tokens (tsc's AST also treats a regex literal as a single token); the
  // 'RegExp' span keeps trivia out. Replaces the base's regex sub-language, which rejects flags, spaces,
  // escaped slashes, alternation groups and `{m,n}` quantifiers.
	public *RegExpLiteral() {
		yield startSpan("RegExp");
		yield eat(m`openToken*: <* '/' />`);
		yield eat(m`pattern*: <*RegExpPattern />`);
		yield eat(m`closeToken*: <* '/' />`);
		if (yield match(m`/[a-zA-Z]/`)) {
			yield eat(m`flags*: <*RegExpFlags />`);
		}

		yield endSpan();
	}

	public *RegExpPattern() {
		yield eat(m`/(?:[^\/\\[\r\n]|\\[^\r\n]|\[(?:[^\]\\\r\n]|\\[^\r\n])*\])+/`);
	}

	public *RegExpFlags() {
		yield eat(m`/[a-zA-Z]+/`);
	}

  // ── expression operators ─────────────────────────────────────────────────────────────────────────────────
  // Own version of es3's LogicExpression (+ es2020's `?.`): fixes the operator alternation order, adds `**`,
  // `??`, logical assignment, optional calls, spread arguments, and the TS forms `as`/`satisfies`, `!`,
  // `f<T>()`. Reached only when shifted (an expression has just been parsed and is held).
	public *LogicExpression({ s, "props": { power, noIn = false } }) {
		const { shifted } = s();

		if (!shifted) {
			return;
		}

		const power_ = power || 16;

		let op = yield match(operatorMatcher);

		if (!op) {
			return;
		}

		op = printSource(op);

    // an arrow function is not a LeftHandSideExpression: `() => {}` followed by `(`/`.`/`[` on the next
    // line starts a new statement (ASI), it is never a call on the arrow
		if (
			["(", ".", "[", "?."].includes(op)
			&& getRoot(shifted).value.name.description === "ArrowFunctionExpression"
		) {
			return;
		}

		switch (op) {
			case ".":
			case "[":
				yield eat(m`<MemberExpression />`, o({ "power": power_ }));

				return;
			case "?.":
				if (power_ < 2) {
					return;
				}

				if (yield match(m`/\?\.[ \t]*[(<]/`)) {
					yield eat(m`<CallExpression />`, o({ "power": power_ }));

					return;
				}

				yield eat(m`<MemberExpression />`, o({ "power": power_ }));

				return;
			case "(":
				if (power_ >= 2) {
					yield eat(m`<CallExpression />`, o({ "power": power_ }));
				}

				return;
			case "!":
				if (power_ >= 3) {
					yield eat(m`<NonNullExpression />`);
				}

				return;
			case "++":
			case "--":
				if (power_ >= 3) {
					yield eat(m`<UnaryExpression />`, o({ "op": op, "power": power_ }));
				}

				return;
			case "as":
			case "satisfies":
				if (power_ >= 8) {
					yield eat(m`<AsExpression />`);
				}

				return;
			case "?":
				if (power_ >= 15) {
					yield eat(m`<TernaryExpression />`, o({ "power": power_ }));
				}

				return;
			case ",":
				if (power_ >= 16) {
					yield eat(m`<SequenceExpression />`, o({ "power": power_ }));
				}

				return;
			// no default
		}

    // `f<T>(x)`: type arguments, tried before `<` as a comparison — only when the text looks like `<…>(`
    // (a failed shift that already adopted the held callee cannot be backtracked cleanly).
		if (op === "<" && power_ >= 2) {
      // `f<T>(x)` vs `a < b` is decided the way tsc does it: parse type arguments speculatively and require `(`.
      // The speculative CallExpression backtracks cleanly as long as nothing INSIDE it commits (W6): its type
      // arguments are therefore eaten behind a `'<'` lookahead rather than with a node literal.
			if (yield eatMatch(m`<CallExpression />`, o({ "power": power_ }))) {
				return;
			}
		}

		if (binaryPowers[op] !== undefined) {
			if (power_ < binaryPowers[op]) {
				return;
			}

			if (op === "in" && noIn) {
				return;
			}

			yield eat(m`<BinaryExpression />`, o({ "op": op, "power": power_, "noIn": noIn }));

			return;
		}

		if (assignmentOperators.has(op) && power_ >= 15) {
			if (!assignableTypes.has(getRoot(shifted).value.name.description)) {
				return;
			}

			yield eat(m`<AssignmentExpression />`, o({ "op": op }));
		}
	}

	public *BinaryExpression({ "props": { op, noIn } }) {
		yield eat(m`left+$: <_Expression />`, o({}), o({ "held": "eat" }));
		yield eat(sigilMatcher("sigilToken", op));
		const ownPower = binaryPowers[op];

		yield eat(m`right+$: <_Expression />`, o({ "power": op === "**" ? ownPower : ownPower - 1, "noIn": noIn }));
	}

	public *AssignmentExpression({ "props": { op } }) {
		yield eat(m`left+$: <_Expression />`, o({}), o({ "held": "eat" }));
		yield eat(sigilMatcher("assignmentOperator", op));
		yield eat(m`right+$: <_Expression />`, o({ "power": 15 }));
	}

  // `x!`
	public *NonNullExpression() {
		yield eat(m`expression+$: <_Expression />`, o({}), o({ "held": "eat" }));
		yield eat(m`sigilToken*: <* '!' />`);
	}

  // `x as T`, `x as const`, `x satisfies T`
	public *AsExpression() {
		yield eat(m`expression+$: <_Expression />`, o({}), o({ "held": "eat" }));
		yield eat(m`sigilToken*: <*Keyword /as|satisfies/ />`);
		if (yield eatMatch(m`constToken*: <*Keyword 'const' />`)) {
			// consumed by the match in the condition; nothing more to eat
		} else {
			yield eat(m`type+$: <_Type />`, o({ "power": 3 }));
		}
	}

  // `<T>x`
	public *TypeAssertion() {
		yield eat(m`openToken*: <* '<' />`);
		yield startSpan("Bare"); // UPSTREAM-WORKAROUND(W1): unguarded, see TypeArguments
		yield eat(m`type+$: <_Type />`);
		yield endSpan();
		yield eat(m`closeToken*: <* '>' />`);
		yield eat(m`expression+$: <_Expression />`, o({ "power": 4 }));
	}

  // `new.target`
	public *MetaProperty() {
		yield eat(m`sigilToken*: <*Keyword 'new' />`);
		yield eat(m`dotToken*: <* '.' />`);
		yield eat(m`property$: <*Identifier />`, o({ "scoped": false }));
	}

  // es6's CallExpression plus `?.(`, `f<T>(` and spread arguments.
	public *CallExpression() {
		yield eat(m`callee+$: <_Expression />`, o({}), o({ "held": "eat" }));
		yield eatMatch(m`optionalToken*: <* '?.' />`);
    // no node literal here: `<TypeArguments '<' />` would COMMIT (W6) and a failed `a < b` could not backtrack
		if (yield match(m`'<'`)) {
			yield eat(m`typeArguments$: <TypeArguments />`);
		}

		yield eat(m`openArgumentsToken*: <* '(' />`);
		yield* argumentList();
		yield eat(m`closeArgumentsToken*: <* ')' />`);
	}

  // es3's NewExpression plus `new C<T>(` and spread arguments.
	public *NewExpression({ "props": { power } }) {
		yield eat(m`sigilToken*: <*Keyword 'new' />`);
		yield eat(m`callee+$: <_Expression />`, o({ "power": 1 }));
		yield eatMatch(m`typeArguments$: <TypeArguments '<' />`);
		const open = power >= 1 ? yield eatMatch(m`openArgumentsToken*: <* '(' />`) : yield eat(m`openArgumentsToken*: <* '(' />`);

		if (open) {
			yield* argumentList();
			yield eat(m`closeArgumentsToken*: <* ')' />`);
		}
	}

  // `: Type` — the node tsval erases; kept as a real CST node so annotations can anchor to it.
	public *TypeAnnotation() {
		yield eat(m`sigilToken*: <* ':' />`);
		if (yield match(typePredicateLookahead)) {
			yield eat(m`predicate$: <TypePredicate />`);
		} else {
			yield eat(m`type+$: <_Type />`);
		}
	}

  // ── types ────────────────────────────────────────────────────────────────────────────────────────────────

  // Cover: eats one primary type, then shifts through postfix/infix forms allowed at `power`.
	public *Type({ s, "props": { power = typePowers.conditional } }) {
		let res;

		if (!s().shifted) {
			res = yield eatMatch(m`<KeywordType ${keywordTypes} />`);

			if (!res) {
				const sigil = yield match(typeSigilMatcher);

				switch (sigil ? printSource(sigil) : null) {
					case BT:
						res = yield eat(m`<TemplateLiteralType />`);
						break;
					case "(":
						res = yield eatMatch(m`<FunctionType />`);

						if (!res) {
							res = yield eat(m`<ParenthesizedType />`);
						}

						break;
					case "<":
					case "new":
					case "abstract":
						res = yield eat(m`<FunctionType />`);
						break;
					case "|":
					case "&":
						res = yield eat(m`<LeadingOperatorType />`);
						break;
					case "infer":
						res = yield eat(m`<InferType />`);
						break;
					case "[":
						res = yield eat(m`<TupleType />`);
						break;
					case "{":
						if (yield match(mappedTypeLookahead)) {
							res = yield eat(m`<MappedType />`);
						} else {
							res = yield eat(m`<TypeLiteral />`);
						}

						break;
					case "typeof":
						res = yield eat(m`<TypeQuery />`);
						break;
					case "keyof":
					case "readonly":
					case "unique":
						res = yield eat(m`<TypeOperator />`);
						break;
					case null:
						res = yield eat(m`<TypeReference />`);
						break;
					default:
						res = yield eat(m`<LiteralType />`);
						break;
				}
			}
		} else {
			res = yield eat(m`<_TypeTail />`, o({ "power": power }));
		}

		if (res && !(yield match(m`/$/`))) {
			return r(shiftMatch(m`<_Type />`, o({ "power": power })));
		}
	}

  // Cover: the postfix/infix continuation of an already-parsed type (the held node).
	public *TypeTail({ s, "props": { power = typePowers.conditional } }) {
		if (!s().shifted) {
			return;
		}

		const op = yield match(m`/\[\]|[[|&]|extends\b/`);

		if (!op) {
			return;
		}

		switch (printSource(op)) {
			case "extends":
				if (power < typePowers.conditional) {
					yield fail();
				}

				yield eat(m`<ConditionalType />`);
				break;
			case "[]":
				yield eat(m`<ArrayType />`);
				break;
			case "[":
				yield eat(m`<IndexedAccessType />`);
				break;
			case "&":
				if (power < typePowers.intersection) {
					yield fail();
				}

				yield eat(m`<IntersectionType />`);
				break;
			case "|":
				if (power < typePowers.union) {
					yield fail();
				}

				yield eat(m`<UnionType />`);
				break;
			// no default
		}
	}

	public *KeywordType() {
		yield eat(m`sigilToken*: <*Keyword ${keywordTypes} />`);
	}

	public *LiteralType() {
		if (yield eatMatch(m`value$: <String /['"]/ />`)) {
			// consumed by the match in the condition; nothing more to eat
		} else if (yield eatMatch(m`value$: <Boolean /true|false/ />`)) {
			// consumed by the match in the condition; nothing more to eat
		} else {
			yield eatMatch(m`signToken*: <* '-' />`);
			yield eat(m`value$: <Number />`);
		}
	}

	public *TypeReference() {
		yield eat(m`name+$: <_TypeName />`);
		yield eatMatch(m`typeArguments$: <TypeArguments '<' />`);
	}

  // `A`, `A.B.C` — a cover: an Identifier that shifts into QualifiedName on `.` (like MemberExpression).
	public *TypeName({ s }) {
		let res;

		if (!s().shifted) {
			res = yield eat(m`<*Identifier />`, o({ "scoped": false }));
		} else if (yield match(m`'.'`)) {
			res = yield eat(m`<QualifiedName />`);
		}

		if (res && (yield match(m`'.'`))) {
			return r(shiftMatch(m`<_TypeName />`));
		}
	}

	public *QualifiedName() {
		yield eat(m`left+$: <_TypeName />`, o({}), o({ "held": "eat" }));
		yield eat(m`dotToken*: <* '.' />`);
		yield eat(m`right$: <*Identifier />`, o({ "scoped": false }));
	}

  // UPSTREAM-WORKAROUND(W1): both lists would be `startSpan('Bare', '>')` + `$` like the base's own lists, but a
  // `>` guard cuts the `=>` of a function type inside the list. Unguarded, with explicit `'>'` tests in place of
  // `$`; a malformed list fails later and with a worse position than a guarded one would.
	public *TypeArguments() {
		yield eat(m`openToken*: <* '<' />`);
		yield startSpan("Bare");
		let sep = true;

		while (sep && !(yield match(m`'>'`))) {
			yield eat(m`params[]+$: <_Type />`);
			sep = yield eatMatch(m`#separatorTokens: <* ',' />`);
		}

		yield endSpan();
		yield eat(m`closeToken*: <* '>' />`);
	}

	public *TypeParameters() {
		yield eat(m`openToken*: <* '<' />`);
		yield startSpan("Bare"); // UPSTREAM-WORKAROUND(W1): see TypeArguments
		let sep = true;

		while (sep && !(yield match(m`'>'`))) {
			yield eat(m`params[]$: <TypeParameter />`);
			sep = yield eatMatch(m`#separatorTokens: <* ',' />`);
		}

		yield endSpan();
		yield eat(m`closeToken*: <* '>' />`);
	}

	public *TypeParameter() {
		while (yield eatMatch(m`modifiers[]*: <*Keyword /(?:const|in|out)\b/ />`)) { /* consumed by eatMatch above */ }
		yield eat(m`name$: <*Identifier />`, o({ "scoped": false }));
		if (yield eatMatch(m`extendsToken*: <*Keyword 'extends' />`)) {
			yield eat(m`constraint+$: <_Type />`);
		}

		if (yield eatMatch(m`defaultToken*: <* '=' />`)) {
			yield eat(m`default+$: <_Type />`);
		}
	}

	public *ArrayType() {
		yield eat(m`elementType+$: <_Type />`, o({}), o({ "held": "eat" }));
    // UPSTREAM-WORKAROUND(W1): one `[]` token rather than an open/close pair, because a separate `]` is cut by an
    // enclosing `]`-guarded span (an array literal or index).
		yield eat(m`bracketsToken*: <* '[]' />`);
	}

	public *IndexedAccessType() {
		yield eat(m`objectType+$: <_Type />`, o({}), o({ "held": "eat" }));
		yield eat(m`openToken*: <* '[' />`);
		yield startSpan("Bare", "]");
		yield eat(m`indexType+$: <_Type />`);
		yield endSpan();
		yield eat(m`closeToken*: <* ']' />`);
	}

	public *UnionType() {
		yield eat(m`left+$: <_Type />`, o({}), o({ "held": "eat" }));
		yield eat(m`sigilToken*: <* '|' />`);
		yield eat(m`right+$: <_Type />`, o({ "power": typePowers.union }));
	}

	public *IntersectionType() {
		yield eat(m`left+$: <_Type />`, o({}), o({ "held": "eat" }));
		yield eat(m`sigilToken*: <* '&' />`);
		yield eat(m`right+$: <_Type />`, o({ "power": typePowers.intersection }));
	}

  // `A extends B ? C : D` — the lowest-precedence type form.
	public *ConditionalType() {
		yield eat(m`checkType+$: <_Type />`, o({}), o({ "held": "eat" }));
		yield eat(m`extendsToken*: <*Keyword 'extends' />`);
		yield eat(m`extendsType+$: <_Type />`, o({ "power": typePowers.union }));
		yield eat(m`questionToken*: <* '?' />`);
		yield eat(m`trueType+$: <_Type />`);
		yield eat(m`colonToken*: <* ':' />`);
		yield eat(m`falseType+$: <_Type />`);
	}

	public *InferType() {
		yield eat(m`sigilToken*: <*Keyword 'infer' />`);
		yield eat(m`name$: <*Identifier />`, o({ "scoped": false }));
	}

  // `| A | B` — a union/intersection written with a leading operator.
	public *LeadingOperatorType() {
		yield eat(m`sigilToken*: <* /[|&]/ />`);
		yield eat(m`type+$: <_Type />`, o({ "power": typePowers.union }));
	}

  // `{ readonly [K in keyof T as N]?: T[K] }`
	public *MappedType() {
		yield eat(m`openToken*: <* '{' />`);
		yield startSpan("Bare", "}");
		yield eatMatch(m`readonlyToken*: <* /[+-]?readonly/ />`);
		yield eat(m`openBracketToken*: <* '[' />`);
		yield eat(m`name$: <*Identifier />`, o({ "scoped": false }));
		yield eat(m`inToken*: <*Keyword 'in' />`);
		yield eat(m`constraint+$: <_Type />`);
		if (yield eatMatch(m`asToken*: <*Keyword 'as' />`)) {
			yield eat(m`nameType+$: <_Type />`);
		}

		yield eat(m`closeBracketToken*: <* ']' />`);
		yield eatMatch(m`optionalToken*: <* /[+-]?\?/ />`);
		yield eatMatch(m`typeAnnotation$: <TypeAnnotation ':' />`);
		yield eatMatch(m`separatorToken*: <* /[;,]/ />`);
		yield endSpan();
		yield eat(m`closeToken*: <* '}' />`);
	}

  // `x is T`, `this is T`, `asserts x`, `asserts x is T` (return positions).
	public *TypePredicate() {
		yield eatMatch(m`assertsToken*: <*Keyword 'asserts' />`);
		if (yield eatMatch(m`parameterName*: <*Keyword 'this' />`)) {
			// consumed by the match in the condition; nothing more to eat
		} else {
			yield eat(m`parameterName*: <*Identifier />`, o({ "scoped": false }));
		}

		if (yield eatMatch(m`isToken*: <*Keyword 'is' />`)) {
			yield eat(m`type+$: <_Type />`);
		}
	}

  // \`get${P}\` — es6's TemplateString with types in the holes (the string content productions are es6's).
	public *TemplateLiteralType() {
		yield eat(templateOpenMatcher);
		yield startSpan("String:Template", BT);

		while ((yield eat(m`quasis[]*: <*StringContent />`)) && (yield eatMatch(typeInterpolationMatcher))) { /* consumed by eatMatch above */ }
		yield eat(templateCloseMatcher);
		yield endSpan();
	}

	public *TypeInterpolation() {
		yield eat(typeInterpolationOpenMatcher);
		yield startSpan("Bare", "}");
		yield eat(m`type+$: <_Type />`);
		yield endSpan();
		yield eat(m`closeToken*: <* '}' />`);
	}

	public *TypeOperator() {
		yield eat(m`sigilToken*: <*Keyword /(?:keyof|readonly|unique)\b/ />`);
		yield eat(m`operand+$: <_Type />`, o({ "power": typePowers.operator }));
	}

	public *TypeQuery() {
		yield eat(m`sigilToken*: <*Keyword 'typeof' />`);
		yield eat(m`name+$: <_TypeName />`);
		yield eatMatch(m`typeArguments$: <TypeArguments '<' />`);
	}

	public *ParenthesizedType() {
		yield eat(m`openToken*: <* '(' />`);
		yield startSpan("Bare", ")");
		yield eat(m`type+$: <_Type />`);
		yield endSpan();
		yield eat(m`closeToken*: <* ')' />`);
	}

  // `(a: T) => R`, `new (a: T) => R`, `<T>(a: T) => R`
	public *FunctionType() {
		yield eatMatch(m`abstractToken*: <*Keyword 'abstract' />`);
		yield eatMatch(m`newToken*: <*Keyword 'new' />`);
		yield eatMatch(m`typeParameters$: <TypeParameters '<' />`);
		yield* parameterList();
		yield eat(m`sigilToken*: <*Keyword '=>' />`);
		yield eat(m`returnType+$: <_Type />`);
	}

	public *TupleType() {
		yield eat(m`openToken*: <* '[' />`);
    // UPSTREAM-WORKAROUND(W1): would be `startSpan('Bare', ']')` + `$` like the base's Array, but a `]` guard cuts
    // the `[]` of `T[]` inside the tuple. Unguarded, with an explicit `']'` test in place of `$`.
		yield startSpan("Bare");
		let sep = true;

		while (sep && !(yield match(m`']'`))) {
			yield eat(m`elements[]$: <TupleElement />`);
			sep = yield eatMatch(m`#separatorTokens: <* ',' />`);
		}

		yield endSpan();
		yield eat(m`closeToken*: <* ']' />`);
	}

  // `T`, `T?`, `...T[]`, `name: T`, `name?: T`, `...name: T[]`
	public *TupleElement() {
		yield eatMatch(m`spreadToken*: <* '...' />`);
		if (yield match(m`/[a-zA-Z_$][a-zA-Z\d_$]*\??:/`)) {
			yield eat(m`name$: <*Identifier />`, o({ "scoped": false }));
			yield eatMatch(m`optionalToken*: <* '?' />`);
			yield eat(m`mapOperator*: <* ':' />`);
			yield eat(m`type+$: <_Type />`);
		} else {
			yield eat(m`type+$: <_Type />`);
			yield eatMatch(m`optionalToken*: <* '?' />`);
		}
	}

  // `{ a: T; b?: U, c(x: T): U; [k: string]: V; readonly d: T; (): T; new (): T }`
	public *TypeLiteral() {
		yield eat(m`openToken*: <* '{' />`);
		yield startSpan("Bare", "}");
		while (!(yield match(m`/$/`))) {
			yield eat(m`members[]+$: <_TypeMember />`);
		}

		yield endSpan();
		yield eat(m`closeToken*: <* '}' />`);
	}

  // Cover: one member of a type literal / interface body (each member eats its own optional `;`/`,`).
	public *TypeMember() {
		if (yield match(m`/\[[a-zA-Z_$][a-zA-Z\d_$]*[ \t]*:/`)) {
			yield eat(m`<IndexSignature />`);
		} else if ((yield match(m`/[(]|new[ \t]*[(]/`)) || (yield match(m`'<'`))) {
			yield eat(m`<CallSignature />`);
		} else if (yield eatMatch(m`<MethodSignature />`)) {
			// consumed by the match in the condition; nothing more to eat
		} else {
			yield eat(m`<PropertySignature />`);
		}
	}

	public *PropertySignature() {
		while (yield eatMatch(m`modifiers[]*: <*Keyword /(?:readonly)\b/ />`)) { /* consumed by eatMatch above */ }
		yield eat(m`key+$: <_ObjectKey />`);
		yield eatMatch(m`optionalToken*: <* '?' />`);
		yield eatMatch(m`typeAnnotation$: <TypeAnnotation ':' />`);
		yield eatMatch(m`separatorToken*: <* /[;,]/ />`);
	}

	public *MethodSignature() {
		while (yield eatMatch(m`modifiers[]*: <*Keyword /(?:readonly)\b/ />`)) { /* consumed by eatMatch above */ }
		yield eat(m`key+$: <_ObjectKey />`);
		yield eatMatch(m`optionalToken*: <* '?' />`);
		if (!((yield match(m`'('`)) || (yield match(m`'<'`)))) {
			yield fail();
		}

		yield eatMatch(m`typeParameters$: <TypeParameters '<' />`);
		yield* parameterList();
		yield eatMatch(m`typeAnnotation$: <TypeAnnotation ':' />`);
		yield eatMatch(m`separatorToken*: <* /[;,]/ />`);
	}

	public *IndexSignature() {
		yield eat(m`openToken*: <* '[' />`);
		yield eat(m`key$: <*Identifier />`, o({ "scoped": false }));
		yield eat(m`keyType$: <TypeAnnotation ':' />`);
		yield eat(m`closeToken*: <* ']' />`);
		yield eat(m`typeAnnotation$: <TypeAnnotation ':' />`);
		yield eatMatch(m`separatorToken*: <* /[;,]/ />`);
	}

	public *CallSignature() {
		yield eatMatch(m`newToken*: <*Keyword 'new' />`);
		yield eatMatch(m`typeParameters$: <TypeParameters '<' />`);
		yield* parameterList();
		yield eatMatch(m`typeAnnotation$: <TypeAnnotation ':' />`);
		yield eatMatch(m`separatorToken*: <* /[;,]/ />`);
	}
}

freezeClass(TypeScriptAtrivial);

// Wrap a grammar class with the trivia handling every es-layer uses (exported so layers/experiments can reuse it).
export function enhance(Grammar) {
	return triviaEnhancer(
		{
			"triviaIsAllowed": (state) => state.span.name === "Bare",

			"Trivia": function *({ s }) {
				const span = BListKeyed.get("Trivia", s().spans);

				const spaces = (span && parseObject(span.props).spaces) ?? Infinity;

				yield startSpan("Trivia", null, span?.props);
				let res = yield match(triviaStartMatcher);

				if (res) {
					res = printSource(res);
				}

      // the base's fast path for a single space assumed every single whitespace char is a space (a lone tab failed)
				if (res?.[0] === " " && res.length === 2 && spaces > 1) {
					yield eat(m`#: <* ' ' />`, o({}), o({ "hold": true }));
				} else {
					yield eat(m`#: <Trivia />`, o({}), o({ "hold": true }));
				}

				yield endSpan();
			}
		},
		Grammar
	);
}

export default enhance(TypeScriptAtrivial);
