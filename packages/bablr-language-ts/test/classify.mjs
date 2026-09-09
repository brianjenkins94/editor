// Failure classification for the round-trip harness, using the TypeScript parser as a *labeler* (never as the
// oracle): given the source and the offset where BABLR stopped/diverged, name the enclosing construct, the next
// construct that begins there, and the token — so failures bucket by construct instead of by file.
import ts from "typescript";

const kindName = (kind) => ts.SyntaxKind[kind];

// Kinds that only exist in TypeScript (erasable or not). JS-shared kinds with TS-only *parts* are handled below.
const TS_ONLY_KINDS = new Set([
	ts.SyntaxKind.InterfaceDeclaration,
	ts.SyntaxKind.TypeAliasDeclaration,
	ts.SyntaxKind.EnumDeclaration,
	ts.SyntaxKind.ModuleDeclaration,
	ts.SyntaxKind.AsExpression,
	ts.SyntaxKind.SatisfiesExpression,
	ts.SyntaxKind.NonNullExpression,
	ts.SyntaxKind.TypeAssertionExpression,
	ts.SyntaxKind.TypeParameter,
	ts.SyntaxKind.Decorator,
	ts.SyntaxKind.ImportEqualsDeclaration,
	ts.SyntaxKind.IndexSignature,
	ts.SyntaxKind.CallSignature,
	ts.SyntaxKind.ConstructSignature,
	ts.SyntaxKind.MethodSignature,
	ts.SyntaxKind.PropertySignature,
	ts.SyntaxKind.ImportType
]);

for (let k = ts.SyntaxKind.FirstTypeNode; k <= ts.SyntaxKind.LastTypeNode; k++) { TS_ONLY_KINDS.add(k); }

const TS_ONLY_MODIFIERS = new Set([
	ts.SyntaxKind.AbstractKeyword,
	ts.SyntaxKind.DeclareKeyword,
	ts.SyntaxKind.OverrideKeyword,
	ts.SyntaxKind.PublicKeyword,
	ts.SyntaxKind.PrivateKeyword,
	ts.SyntaxKind.ProtectedKeyword,
	ts.SyntaxKind.ReadonlyKeyword,
	ts.SyntaxKind.InKeyword,
	ts.SyntaxKind.OutKeyword,
	ts.SyntaxKind.AccessorKeyword
]);

export function parse(name, source) {
	return ts.createSourceFile(name || "case.ts", source, ts.ScriptTarget.Latest, true, /\.js$/.test(name || "") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
}

/** True when the program uses any TypeScript-only syntax (so a failure on it may just be the missing TS layer). */
export function usesTsSyntax(sf) {
	try {
		return usesTsSyntaxUnsafe(sf);
	} catch (e) {
		if (e instanceof RangeError) { return false; } // pathologically deep tree (stress case)
		throw e;
	}
}

function usesTsSyntaxUnsafe(sf) {
	let found = false;
	const visit = (node) => {
		if (found) { return; }
		if (TS_ONLY_KINDS.has(node.kind)) { return void (found = true); }
		if (node.type !== undefined && node.kind !== ts.SyntaxKind.ConditionalExpression) { return void (found = true); }
		if (node.typeArguments !== undefined || node.typeParameters !== undefined) { return void (found = true); }
		if (node.kind === ts.SyntaxKind.HeritageClause && node.token === ts.SyntaxKind.ImplementsKeyword) { return void (found = true); }
		if ((node.questionToken !== undefined || node.exclamationToken !== undefined) && node.kind !== ts.SyntaxKind.ConditionalExpression) { return void (found = true); }
		if (ts.canHaveModifiers(node)) {
			for (const m of ts.getModifiers(node) ?? []) {
				if (TS_ONLY_MODIFIERS.has(m.kind)) { return void (found = true); }
				if (m.kind === ts.SyntaxKind.ConstKeyword && node.kind !== ts.SyntaxKind.VariableStatement) { return void (found = true); }
			}
		}

		ts.forEachChild(node, visit);
	};

	visit(sf);

	return found;
}

/** Describe what sits at `pos` in the source. */
export function locate(sf, source, pos) {
	pos = Math.max(0, Math.min(pos, source.length));
	let node = sf;

	for (let depth = 0; depth < 5000; depth++) {
		const child = ts.forEachChild(node, (c) => (c.getStart(sf) <= pos && pos < c.end ? c : undefined));

		if (!child) { break; }
		node = child;
	}

	let next;

	ts.forEachChild(node, (c) => {
		if (next === undefined && c.getStart(sf) >= pos) { next = c; }
	});
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);

	scanner.resetTokenState(pos);
	const tokenKind = scanner.scan();
	const token = scanner.getTokenText();
	const { line, character } = sf.getLineAndCharacterOfPosition(pos);
	const excerpt = `${source.slice(Math.max(0, pos - 40), pos)}⟨⟩${source.slice(pos, pos + 40)}`.replace(/\n/g, "⏎");

	return {
		"container": kindName(node.kind),
		"next": next ? kindName(next.kind) : null,
		"token": token,
		"tokenKind": kindName(tokenKind),
		"line": line + 1,
		"col": character + 1,
		"excerpt": excerpt
	};
}

/** A stable bucket key for a located failure. */
export const bucketKey = (loc) => `${loc.container} > ${loc.next ?? "·"} @ ${JSON.stringify(loc.token)}`;

// ── feature census ─────────────────────────────────────────────────────────────────────────────────────────────
// Tags the syntactic features a subtree uses (JS features by construct, TS features by kind + annotation site),
// so a failing statement can be described by what it CONTAINS rather than where the VM stopped.
const K = ts.SyntaxKind;
const ES5_RESERVED_IDENTIFIERS = new Set(["arguments", "eval", "await", "yield", "let", "static", "implements", "interface", "package", "private", "protected", "public", "async", "of", "get", "set", "from", "as"]);
const hasMod = (node, kind) => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
const trailingComma = (list) => list !== undefined && list.hasTrailingComma;

export function features(root, sf) {
	try {
		return featuresUnsafe(root, sf);
	} catch (e) {
		if (e instanceof RangeError) { return new Set(["(too deep to classify)"]); }
		throw e;
	}
}

function featuresUnsafe(root, sf) {
	const out = new Set();
	const add = (f) => out.add(f);
	const visit = (node) => {
		switch (node.kind) {
			case K.Identifier: {
				const t = node.text;

				if (ES5_RESERVED_IDENTIFIERS.has(t)) { add(`Identifier:${t}`); }
				if (/[^\x00-\x7F]/.test(t)) { add("Identifier:nonAscii"); }
				if (node.getText(sf).includes("\\")) { add("Identifier:unicodeEscape"); }
				break;
			}

			case K.PrivateIdentifier: add("PrivateName"); break;
			case K.ArrowFunction: {
				const async = hasMod(node, K.AsyncKeyword);
				const bare = node.parameters.length === 1 && !/^\(/.test(node.getText(sf).replace(/^async\s+/, ""));

				add(bare ? "ArrowFunction:bareParam" : "ArrowFunction");
				if (async) { add("ArrowFunction:async"); }
				if (node.body.kind !== K.Block) { add("ArrowFunction:exprBody"); }
				if (trailingComma(node.parameters)) { add("TrailingComma:params"); }
				break;
			}

			case K.FunctionDeclaration:
			case K.FunctionExpression: {
				const a = hasMod(node, K.AsyncKeyword); const
					g = Boolean(node.asteriskToken);

				add(a && g ? "AsyncGenerator" : a ? "AsyncFunction" : g ? "Generator" : ts.SyntaxKind[node.kind]);
				if (node.kind === K.FunctionDeclaration && node.parent && node.parent.kind !== K.SourceFile) { add("FunctionDeclaration:nested"); }
				if (!node.body) { add("Overload"); }
				if (trailingComma(node.parameters)) { add("TrailingComma:params"); }
				break;
			}

			case K.MethodDeclaration: {
				const obj = node.parent?.kind === K.ObjectLiteralExpression;
				const a = hasMod(node, K.AsyncKeyword); const
					g = Boolean(node.asteriskToken);

				add(`${obj ? "ObjectMethod" : "ClassMethod"}${a && g ? ":asyncGen" : a ? ":async" : g ? ":gen" : ""}`);
				if (!obj && hasMod(node, K.StaticKeyword)) { add("ClassMethod:static"); }
				if (node.name?.kind === K.StringLiteral) { add("MemberName:string"); }
				if (node.name?.kind === K.NumericLiteral) { add("MemberName:numeric"); }
				if (!node.body) { add("Overload"); }
				if (trailingComma(node.parameters)) { add("TrailingComma:params"); }
				break;
			}

			case K.GetAccessor:
			case K.SetAccessor: {
				const obj = node.parent?.kind === K.ObjectLiteralExpression;

				add(obj ? "ObjectAccessor" : "ClassAccessor");
				if (!obj && hasMod(node, K.StaticKeyword)) { add("ClassAccessor:static"); }
				if (node.name?.kind === K.StringLiteral) { add("MemberName:string"); }
				break;
			}

			case K.PropertyDeclaration:
				add("ClassField");
				if (hasMod(node, K.StaticKeyword)) { add("ClassField:static"); }
				if (!node.initializer) { add("ClassField:noInitializer"); }
				if (node.name?.kind === K.StringLiteral) { add("MemberName:string"); }
				if (node.name?.kind === K.NumericLiteral) { add("MemberName:numeric"); }
				break;
			case K.ClassStaticBlockDeclaration: add("ClassStaticBlock"); break;
			case K.Constructor: add("Constructor"); break;
			case K.ClassDeclaration:
			case K.ClassExpression:
				add(ts.SyntaxKind[node.kind]);
				if (node.heritageClauses?.some((h) => h.token === K.ExtendsKeyword)) { add("Class:extends"); }
				if (node.members.length === 0) { add("Class:empty"); }
				break;
			case K.SpreadAssignment: add("ObjectSpread"); break;
			case K.SpreadElement: add(node.parent?.kind === K.ArrayLiteralExpression ? "ArraySpread" : "CallSpread"); break;
			case K.ShorthandPropertyAssignment: add("ShorthandProperty"); break;
			case K.ComputedPropertyName: add("ComputedKey"); break;
			case K.PropertyAssignment:
				if (node.name?.kind === K.StringLiteral) { add("ObjectKey:string"); }
				if (node.name?.kind === K.NumericLiteral) { add("ObjectKey:numeric"); }
				if (node.name?.kind === K.Identifier && ES5_RESERVED_IDENTIFIERS.has(node.name.text)) { add("ObjectKey:reservedish"); }
				if (node.name?.getText(sf) === "__proto__") { add("ObjectKey:__proto__"); }
				break;
			case K.ObjectBindingPattern:
			case K.ArrayBindingPattern: {
				let ctx = "nested";
				const p = node.parent;

				if (p?.kind === K.Parameter) { ctx = "param"; } else if (p?.kind === K.VariableDeclaration) {
					const flags = p.parent?.flags ?? 0;

					ctx = flags & ts.NodeFlags.Const ? "const" : flags & ts.NodeFlags.Let ? "let" : "var";
					const gp = p.parent?.parent;

					if (gp?.kind === K.ForOfStatement || gp?.kind === K.ForInStatement || gp?.kind === K.ForStatement) { ctx += ":for"; }
				} else if (p?.kind === K.CatchClause) { ctx = "catch"; }

				add(`${node.kind === K.ObjectBindingPattern ? "ObjectPattern" : "ArrayPattern"}:${ctx}`);
				break;
			}

			case K.BindingElement:
				if (node.dotDotDotToken) { add("BindingRest"); }
				if (node.initializer) { add("BindingDefault"); }
				if (node.propertyName) { add("BindingRename"); }
				break;
			case K.OmittedExpression: add("Elision"); break;
			case K.BinaryExpression: {
				const op = node.operatorToken.kind;
				const text = node.operatorToken.getText(sf);

				if (op === K.EqualsToken && (node.left.kind === K.ArrayLiteralExpression || node.left.kind === K.ObjectLiteralExpression)) { add("DestructuringAssignment"); }
				if (op === K.CommaToken) { add("Comma"); } else if ([K.QuestionQuestionToken, K.AsteriskAsteriskToken, K.InKeyword, K.InstanceOfKeyword, K.QuestionQuestionEqualsToken, K.BarBarEqualsToken, K.AmpersandAmpersandEqualsToken, K.AsteriskAsteriskEqualsToken, K.GreaterThanGreaterThanGreaterThanEqualsToken, K.GreaterThanGreaterThanGreaterThanToken].includes(op)) { add(`Binary:${text}`); } else if (op !== K.EqualsToken && text.endsWith("=") && !/^[=!<>]=+$/.test(text)) { add("CompoundAssignment"); }

				if (node.left.kind === K.PrivateIdentifier) { add("PrivateIn"); }
				break;
			}

			case K.PrefixUnaryExpression: add(`Prefix:${ts.tokenToString(node.operator)}`); break;
			case K.PostfixUnaryExpression: add(`Postfix:${ts.tokenToString(node.operator)}`); break;
			case K.TypeOfExpression: add("typeof"); break;
			case K.VoidExpression: add("void"); break;
			case K.DeleteExpression: add("delete"); break;
			case K.AwaitExpression: add("await"); break;
			case K.YieldExpression: add(node.asteriskToken ? "yield*" : node.expression ? "yield" : "yield:bare"); break;
			case K.PropertyAccessExpression:
			case K.ElementAccessExpression:
				if (node.questionDotToken) { add("OptionalChain"); }
				if (node.kind === K.PropertyAccessExpression && node.name.kind === K.PrivateIdentifier) { add("PrivateAccess"); }
				if (node.kind === K.PropertyAccessExpression && ES5_RESERVED_IDENTIFIERS.has(node.name.text)) { add("PropertyName:reservedish"); }
				if (node.expression.kind === K.SuperKeyword) { add("SuperProperty"); }
				break;
			case K.CallExpression:
				if (node.questionDotToken) { add("OptionalCall"); }
				if (node.expression.kind === K.ImportKeyword) { add("DynamicImport"); }
				if (node.expression.kind === K.SuperKeyword) { add("SuperCall"); }
				if (trailingComma(node.arguments)) { add("TrailingComma:args"); }
				if (node.arguments.length === 0) { add("Call:noArgs"); }
				break;
			case K.MetaProperty: add(`MetaProperty:${node.getText(sf)}`); break;
			case K.NewExpression:
				add(node.arguments ? "New" : "New:noParens");
				if (node.expression.kind === K.CallExpression || node.expression.kind === K.PropertyAccessExpression) { add("New:memberCallee"); }
				break;
			case K.TaggedTemplateExpression: add("TaggedTemplate"); break;
			case K.TemplateExpression: add("Template"); break;
			case K.NoSubstitutionTemplateLiteral: add("Template:noSubst"); break;
			case K.NumericLiteral: {
				const t = node.getText(sf);

				if (t.includes("_")) { add("Numeric:separator"); }
				if (/^0x/i.test(t)) { add("Numeric:hex"); } else if (/^0o/i.test(t)) { add("Numeric:octal"); } else if (/^0b/i.test(t)) { add("Numeric:binary"); } else if (/^0\d/.test(t)) { add("Numeric:legacyOctal"); } else {
					if (/^\./.test(t)) { add("Numeric:leadingDot"); }
					if (/\.$/.test(t) || /\.e/i.test(t)) { add("Numeric:trailingDot"); }
					if (/e/i.test(t)) { add("Numeric:exponent"); }
					if (/\d\.\d/.test(t)) { add("Numeric:decimal"); }
				}

				break;
			}

			case K.BigIntLiteral: add("BigInt"); break;
			case K.RegularExpressionLiteral: {
				add("Regex");
				const t = node.getText(sf);
				const flags = t.slice(t.lastIndexOf("/") + 1);

				for (const f of flags) { add(`Regex:flag:${f}`); }
				if (t.includes("[")) { add("Regex:class"); }
				if (/\\[pPu]/.test(t)) { add("Regex:unicodeEscape"); }
				if (/\(\?</.test(t)) { add("Regex:namedGroup|lookbehind"); }
				break;
			}

			case K.StringLiteral: {
				const t = node.getText(sf);

				if (t.includes("\\")) { add("String:escape"); }
				if (/\\\r?\n/.test(t)) { add("String:lineContinuation"); }
				if (/\\u\{/.test(t)) { add("String:codePointEscape"); }
				if (/\\u[0-9a-fA-F]{4}/.test(t)) { add("String:unicodeEscape"); }
				if (/\\x/.test(t)) { add("String:hexEscape"); }
				if (/\\[0-7]/.test(t)) { add("String:octalEscape"); }
				if (/[^\x00-\x7F]/.test(t)) { add("String:nonAscii"); }
				if (node.parent?.kind === K.ExpressionStatement) { add("Directive"); }
				break;
			}

			case K.ForOfStatement: add(node.awaitModifier ? "ForAwaitOf" : "ForOf"); break;
			case K.ForInStatement: add("ForIn"); break;
			case K.ForStatement: add("For"); if (!node.initializer && !node.condition && !node.incrementor) { add("For:empty"); } break;
			case K.LabeledStatement: add("Labeled"); break;
			case K.SwitchStatement: add("Switch"); break;
			case K.DoStatement: add("DoWhile"); break;
			case K.WhileStatement: add("While"); break;
			case K.IfStatement: add(node.elseStatement ? "If:else" : "If"); break;
			case K.TryStatement: add(node.finallyBlock ? (node.catchClause ? "Try:catch:finally" : "Try:finally") : "Try:catch"); break;
			case K.CatchClause: if (!node.variableDeclaration) { add("OptionalCatchBinding"); } break;
			case K.WithStatement: add("With"); break;
			case K.DebuggerStatement: add("Debugger"); break;
			case K.EmptyStatement: add("EmptyStatement"); break;
			case K.ConditionalExpression: add("Conditional"); break;
			case K.ParenthesizedExpression: add("Parenthesized"); break;
			case K.Block: if (node.parent && [K.Block, K.SourceFile, K.CaseClause, K.DefaultClause].includes(node.parent.kind)) { add("BlockStatement"); } break;
			case K.VariableDeclarationList: {
				const f = node.flags;

				add(f & ts.NodeFlags.Const ? "const" : f & ts.NodeFlags.Let ? "let" : f & ts.NodeFlags.Using ? "using" : "var");
				if (node.declarations.length > 1) { add("MultiDeclarator"); }
				if (node.declarations.some((d) => !d.initializer)) { add("Declarator:noInit"); }
				break;
			}

			case K.Parameter:
				if (node.dotDotDotToken) { add("RestParam"); }
				if (node.initializer) { add("DefaultParam"); }
				if (node.name?.kind === K.Identifier && node.name.text === "this") { add("ThisParam"); }
				break;
			case K.ObjectLiteralExpression: add(node.properties.length ? "ObjectLiteral" : "ObjectLiteral:empty"); if (trailingComma(node.properties)) { add("TrailingComma:object"); } break;
			case K.ArrayLiteralExpression: add(node.elements.length ? "ArrayLiteral" : "ArrayLiteral:empty"); if (trailingComma(node.elements)) { add("TrailingComma:array"); } break;
			case K.ThisKeyword: add("this"); break;
			case K.SuperKeyword: add("super"); break;
			case K.NullKeyword: add("null"); break;
			case K.TrueKeyword: case K.FalseKeyword: add("boolean"); break;
			case K.ReturnStatement: add(node.expression ? "Return" : "Return:bare"); break;
			case K.ThrowStatement: add("Throw"); break;
			case K.BreakStatement: add(node.label ? "Break:label" : "Break"); break;
			case K.ContinueStatement: add(node.label ? "Continue:label" : "Continue"); break;
			case K.ImportDeclaration: case K.ExportDeclaration: case K.ExportAssignment: add("Module"); break;
			case K.SemicolonClassElement: add("Class:semicolonMember"); break;
			// no default
		}

    // TypeScript-only parts, tagged by site
		if (TS_ONLY_KINDS.has(node.kind)) { add(`TS:${ts.SyntaxKind[node.kind]}`); }
		if (node.type !== undefined && node.kind !== K.ConditionalExpression && !TS_ONLY_KINDS.has(node.kind)) { add(`TS:Type@${ts.SyntaxKind[node.kind]}`); }
		if (node.typeArguments !== undefined) { add(`TS:TypeArgs@${ts.SyntaxKind[node.kind]}`); }
		if (node.typeParameters !== undefined) { add(`TS:TypeParams@${ts.SyntaxKind[node.kind]}`); }
		if (node.kind === K.HeritageClause && node.token === K.ImplementsKeyword) { add("TS:implements"); }
		if (node.questionToken !== undefined && node.kind !== K.ConditionalExpression && node.kind !== K.ConditionalType) { add(`TS:Optional@${ts.SyntaxKind[node.kind]}`); }
		if (node.exclamationToken !== undefined) { add(`TS:Definite@${ts.SyntaxKind[node.kind]}`); }
		if (ts.canHaveModifiers(node)) {
			for (const m of ts.getModifiers(node) ?? []) {
				if (TS_ONLY_MODIFIERS.has(m.kind) || (m.kind === K.ConstKeyword && node.kind !== K.VariableStatement)) { add(`TS:mod:${ts.tokenToString(m.kind)}`); }
			}
		}

		if (ts.canHaveModifiers(node) && hasMod(node, K.ExportKeyword)) { add("Module"); }
		ts.forEachChild(node, visit);
	};

	visit(root);

	return out;
}

// Unicode built from code points so this source stays ASCII.
const ch = (code) => String.fromCharCode(code);
const LINE_SEPARATORS = new RegExp(`[${ch(0x2028)}${ch(0x2029)}]`);
const NEXT_LINE = ch(0x85);
const UNICODE_SPACES = new RegExp(`[${ch(0xA0)}${ch(0xFEFF)}${ch(0x2000)}-${ch(0x200B)}${ch(0x3000)}]`);

/** Features of the raw text that no AST node carries. */
export function textFeatures(source) {
	const out = new Set();

	if (source.charCodeAt(0) === 0xFEFF) { out.add("BOM"); }
	if (source.startsWith("#!")) { out.add("Hashbang"); }
	if (source.includes("\r\n")) { out.add("CRLF"); } else if (source.includes("\r")) { out.add("CR"); }

	if (LINE_SEPARATORS.test(source)) { out.add("LS/PS"); }
	if (source.includes(NEXT_LINE)) { out.add("NEL"); }
	if (/<!--|^-->/m.test(source)) { out.add("HTMLComment"); }
	if (source.includes("/*")) { out.add("Comment:block"); }
	if (/\/\//.test(source)) { out.add("Comment:line"); }
	if (/\t/.test(source)) { out.add("Tab"); }
	if (UNICODE_SPACES.test(source.slice(1))) { out.add("UnicodeSpace"); }
	if (source.length && !/\n$/.test(source)) { out.add("NoTrailingNewline"); }
	if (source.trim() === "") { out.add("EmptyFile"); }

	return out;
}

/** The top-level statement whose full range (leading trivia included) contains `pos`; null at EOF. */
export function statementAt(sf, pos) {
	for (const s of sf.statements) {
		if (pos < s.end) { return s; }
	}

	return null;
}
