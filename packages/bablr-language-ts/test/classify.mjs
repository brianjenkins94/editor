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

for (let kind = ts.SyntaxKind.FirstTypeNode; kind <= ts.SyntaxKind.LastTypeNode; kind++) {
	TS_ONLY_KINDS.add(kind);
}

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
	return ts.createSourceFile(name || "case.ts", source, ts.ScriptTarget.Latest, true, /\.js$/u.test(name || "") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
}

/** True when the program uses any TypeScript-only syntax (so a failure on it may just be the missing TS layer). */
export function usesTsSyntax(sf) {
	try {
		return usesTsSyntaxUnsafe(sf);
	} catch (error) {
		if (error instanceof RangeError) {
			return false; // pathologically deep tree (stress case)
		}

		throw error;
	}
}

function usesTsSyntaxUnsafe(sf) {
	let found = false;
	const visit = (node) => {
		if (found) {
			return;
		}

		if (TS_ONLY_KINDS.has(node.kind)) {
			found = true;

			return;
		}

		if (node.type !== undefined && node.kind !== ts.SyntaxKind.ConditionalExpression) {
			found = true;

			return;
		}

		if (node.typeArguments !== undefined || node.typeParameters !== undefined) {
			found = true;

			return;
		}

		if (node.kind === ts.SyntaxKind.HeritageClause && node.token === ts.SyntaxKind.ImplementsKeyword) {
			found = true;

			return;
		}

		if ((node.questionToken !== undefined || node.exclamationToken !== undefined) && node.kind !== ts.SyntaxKind.ConditionalExpression) {
			found = true;

			return;
		}

		if (ts.canHaveModifiers(node)) {
			for (const modifier of ts.getModifiers(node) ?? []) {
				if (TS_ONLY_MODIFIERS.has(modifier.kind)) {
					found = true;

					return;
				}

				if (modifier.kind === ts.SyntaxKind.ConstKeyword && node.kind !== ts.SyntaxKind.VariableStatement) {
					found = true;

					return;
				}
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
		const child = ts.forEachChild(node, (candidate) => (candidate.getStart(sf) <= pos && pos < candidate.end ? candidate : undefined));

		if (!child) {
			break;
		}

		node = child;
	}

	let next;

	ts.forEachChild(node, (candidate) => {
		if (next === undefined && candidate.getStart(sf) >= pos) {
			next = candidate;
		}
	});
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);

	scanner.resetTokenState(pos);
	const tokenKind = scanner.scan();
	const token = scanner.getTokenText();
	const { line, character } = sf.getLineAndCharacterOfPosition(pos);
	const excerpt = `${source.slice(Math.max(0, pos - 40), pos)}⟨⟩${source.slice(pos, pos + 40)}`.replace(/\n/gu, "⏎");

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
const Kind = ts.SyntaxKind;
const ES5_RESERVED_IDENTIFIERS = new Set(["arguments", "eval", "await", "yield", "let", "static", "implements", "interface", "package", "private", "protected", "public", "async", "of", "get", "set", "from", "as"]);
const hasMod = (node, kind) => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
const trailingComma = (list) => list !== undefined && list.hasTrailingComma;

export function features(root, sf) {
	try {
		return featuresUnsafe(root, sf);
	} catch (error) {
		if (error instanceof RangeError) {
			return new Set(["(too deep to classify)"]);
		}

		throw error;
	}
}

function featuresUnsafe(root, sf) {
	const out = new Set();
	const add = (feature) => out.add(feature);
	const visit = (node) => {
		switch (node.kind) {
			case Kind.Identifier: {
				const text = node.text;

				if (ES5_RESERVED_IDENTIFIERS.has(text)) {
					add(`Identifier:${text}`);
				}

				if (/[^\x00-\x7F]/u.test(text)) {
					add("Identifier:nonAscii");
				}

				if (node.getText(sf).includes("\\")) {
					add("Identifier:unicodeEscape");
				}

				break;
			}

			case Kind.PrivateIdentifier:
				add("PrivateName");
				break;
			case Kind.ArrowFunction: {
				const async = hasMod(node, Kind.AsyncKeyword);
				const bare = node.parameters.length === 1 && !/^\(/u.test(node.getText(sf).replace(/^async\s+/u, ""));

				add(bare ? "ArrowFunction:bareParam" : "ArrowFunction");
				if (async) {
					add("ArrowFunction:async");
				}

				if (node.body.kind !== Kind.Block) {
					add("ArrowFunction:exprBody");
				}

				if (trailingComma(node.parameters)) {
					add("TrailingComma:params");
				}

				break;
			}

			case Kind.FunctionDeclaration:
			case Kind.FunctionExpression: {
				const isAsync = hasMod(node, Kind.AsyncKeyword);
				const isGenerator = Boolean(node.asteriskToken);
				let kindLabel;

				if (isAsync && isGenerator) {
					kindLabel = "AsyncGenerator";
				} else if (isAsync) {
					kindLabel = "AsyncFunction";
				} else if (isGenerator) {
					kindLabel = "Generator";
				} else {
					kindLabel = ts.SyntaxKind[node.kind];
				}

				add(kindLabel);
				if (node.kind === Kind.FunctionDeclaration && node.parent && node.parent.kind !== Kind.SourceFile) {
					add("FunctionDeclaration:nested");
				}

				if (!node.body) {
					add("Overload");
				}

				if (trailingComma(node.parameters)) {
					add("TrailingComma:params");
				}

				break;
			}

			case Kind.MethodDeclaration: {
				const obj = node.parent?.kind === Kind.ObjectLiteralExpression;
				const isAsync = hasMod(node, Kind.AsyncKeyword);
				const isGenerator = Boolean(node.asteriskToken);
				let suffix;

				if (isAsync && isGenerator) {
					suffix = ":asyncGen";
				} else if (isAsync) {
					suffix = ":async";
				} else if (isGenerator) {
					suffix = ":gen";
				} else {
					suffix = "";
				}

				add(`${obj ? "ObjectMethod" : "ClassMethod"}${suffix}`);
				if (!obj && hasMod(node, Kind.StaticKeyword)) {
					add("ClassMethod:static");
				}

				if (node.name?.kind === Kind.StringLiteral) {
					add("MemberName:string");
				}

				if (node.name?.kind === Kind.NumericLiteral) {
					add("MemberName:numeric");
				}

				if (!node.body) {
					add("Overload");
				}

				if (trailingComma(node.parameters)) {
					add("TrailingComma:params");
				}

				break;
			}

			case Kind.GetAccessor:
			case Kind.SetAccessor: {
				const obj = node.parent?.kind === Kind.ObjectLiteralExpression;

				add(obj ? "ObjectAccessor" : "ClassAccessor");
				if (!obj && hasMod(node, Kind.StaticKeyword)) {
					add("ClassAccessor:static");
				}

				if (node.name?.kind === Kind.StringLiteral) {
					add("MemberName:string");
				}

				break;
			}

			case Kind.PropertyDeclaration:
				add("ClassField");
				if (hasMod(node, Kind.StaticKeyword)) {
					add("ClassField:static");
				}

				if (!node.initializer) {
					add("ClassField:noInitializer");
				}

				if (node.name?.kind === Kind.StringLiteral) {
					add("MemberName:string");
				}

				if (node.name?.kind === Kind.NumericLiteral) {
					add("MemberName:numeric");
				}

				break;
			case Kind.ClassStaticBlockDeclaration:
				add("ClassStaticBlock");
				break;
			case Kind.Constructor:
				add("Constructor");
				break;
			case Kind.ClassDeclaration:
			case Kind.ClassExpression:
				add(ts.SyntaxKind[node.kind]);
				if (node.heritageClauses?.some((heritage) => heritage.token === Kind.ExtendsKeyword)) {
					add("Class:extends");
				}

				if (node.members.length === 0) {
					add("Class:empty");
				}

				break;
			case Kind.SpreadAssignment:
				add("ObjectSpread");
				break;
			case Kind.SpreadElement:
				add(node.parent?.kind === Kind.ArrayLiteralExpression ? "ArraySpread" : "CallSpread");
				break;
			case Kind.ShorthandPropertyAssignment:
				add("ShorthandProperty");
				break;
			case Kind.ComputedPropertyName:
				add("ComputedKey");
				break;
			case Kind.PropertyAssignment:
				if (node.name?.kind === Kind.StringLiteral) {
					add("ObjectKey:string");
				}

				if (node.name?.kind === Kind.NumericLiteral) {
					add("ObjectKey:numeric");
				}

				if (node.name?.kind === Kind.Identifier && ES5_RESERVED_IDENTIFIERS.has(node.name.text)) {
					add("ObjectKey:reservedish");
				}

				if (node.name?.getText(sf) === "__proto__") {
					add("ObjectKey:__proto__");
				}

				break;
			case Kind.ObjectBindingPattern:
			case Kind.ArrayBindingPattern: {
				let ctx = "nested";
				const parent = node.parent;

				if (parent?.kind === Kind.Parameter) {
					ctx = "param";
				} else if (parent?.kind === Kind.VariableDeclaration) {
					const flags = parent.parent?.flags ?? 0;

					if (flags & ts.NodeFlags.Const) {
						ctx = "const";
					} else if (flags & ts.NodeFlags.Let) {
						ctx = "let";
					} else {
						ctx = "var";
					}

					const grandParent = parent.parent?.parent;

					if (grandParent?.kind === Kind.ForOfStatement || grandParent?.kind === Kind.ForInStatement || grandParent?.kind === Kind.ForStatement) {
						ctx += ":for";
					}
				} else if (parent?.kind === Kind.CatchClause) {
					ctx = "catch";
				}

				add(`${node.kind === Kind.ObjectBindingPattern ? "ObjectPattern" : "ArrayPattern"}:${ctx}`);
				break;
			}

			case Kind.BindingElement:
				if (node.dotDotDotToken) {
					add("BindingRest");
				}

				if (node.initializer) {
					add("BindingDefault");
				}

				if (node.propertyName) {
					add("BindingRename");
				}

				break;
			case Kind.OmittedExpression:
				add("Elision");
				break;
			case Kind.BinaryExpression: {
				const op = node.operatorToken.kind;
				const text = node.operatorToken.getText(sf);

				if (op === Kind.EqualsToken && (node.left.kind === Kind.ArrayLiteralExpression || node.left.kind === Kind.ObjectLiteralExpression)) {
					add("DestructuringAssignment");
				}

				if (op === Kind.CommaToken) {
					add("Comma");
				} else if ([Kind.QuestionQuestionToken, Kind.AsteriskAsteriskToken, Kind.InKeyword, Kind.InstanceOfKeyword, Kind.QuestionQuestionEqualsToken, Kind.BarBarEqualsToken, Kind.AmpersandAmpersandEqualsToken, Kind.AsteriskAsteriskEqualsToken, Kind.GreaterThanGreaterThanGreaterThanEqualsToken, Kind.GreaterThanGreaterThanGreaterThanToken].includes(op)) {
					add(`Binary:${text}`);
				} else if (op !== Kind.EqualsToken && text.endsWith("=") && !/^[=!<>]=+$/u.test(text)) {
					add("CompoundAssignment");
				}

				if (node.left.kind === Kind.PrivateIdentifier) {
					add("PrivateIn");
				}

				break;
			}

			case Kind.PrefixUnaryExpression:
				add(`Prefix:${ts.tokenToString(node.operator)}`);
				break;
			case Kind.PostfixUnaryExpression:
				add(`Postfix:${ts.tokenToString(node.operator)}`);
				break;
			case Kind.TypeOfExpression:
				add("typeof");
				break;
			case Kind.VoidExpression:
				add("void");
				break;
			case Kind.DeleteExpression:
				add("delete");
				break;
			case Kind.AwaitExpression:
				add("await");
				break;
			case Kind.YieldExpression: {
				let yieldLabel;

				if (node.asteriskToken) {
					yieldLabel = "yield*";
				} else if (node.expression) {
					yieldLabel = "yield";
				} else {
					yieldLabel = "yield:bare";
				}

				add(yieldLabel);
				break;
			}

			case Kind.PropertyAccessExpression:
			case Kind.ElementAccessExpression:
				if (node.questionDotToken) {
					add("OptionalChain");
				}

				if (node.kind === Kind.PropertyAccessExpression && node.name.kind === Kind.PrivateIdentifier) {
					add("PrivateAccess");
				}

				if (node.kind === Kind.PropertyAccessExpression && ES5_RESERVED_IDENTIFIERS.has(node.name.text)) {
					add("PropertyName:reservedish");
				}

				if (node.expression.kind === Kind.SuperKeyword) {
					add("SuperProperty");
				}

				break;
			case Kind.CallExpression:
				if (node.questionDotToken) {
					add("OptionalCall");
				}

				if (node.expression.kind === Kind.ImportKeyword) {
					add("DynamicImport");
				}

				if (node.expression.kind === Kind.SuperKeyword) {
					add("SuperCall");
				}

				if (trailingComma(node.arguments)) {
					add("TrailingComma:args");
				}

				if (node.arguments.length === 0) {
					add("Call:noArgs");
				}

				break;
			case Kind.MetaProperty:
				add(`MetaProperty:${node.getText(sf)}`);
				break;
			case Kind.NewExpression:
				add(node.arguments ? "New" : "New:noParens");
				if (node.expression.kind === Kind.CallExpression || node.expression.kind === Kind.PropertyAccessExpression) {
					add("New:memberCallee");
				}

				break;
			case Kind.TaggedTemplateExpression:
				add("TaggedTemplate");
				break;
			case Kind.TemplateExpression:
				add("Template");
				break;
			case Kind.NoSubstitutionTemplateLiteral:
				add("Template:noSubst");
				break;
			case Kind.NumericLiteral: {
				const text = node.getText(sf);

				if (text.includes("_")) {
					add("Numeric:separator");
				}

				if (/^0x/iu.test(text)) {
					add("Numeric:hex");
				} else if (/^0o/iu.test(text)) {
					add("Numeric:octal");
				} else if (/^0b/iu.test(text)) {
					add("Numeric:binary");
				} else if (/^0\d/u.test(text)) {
					add("Numeric:legacyOctal");
				} else {
					if (/^\./u.test(text)) {
						add("Numeric:leadingDot");
					}

					if (/\.$/u.test(text) || /\.e/iu.test(text)) {
						add("Numeric:trailingDot");
					}

					if (/e/iu.test(text)) {
						add("Numeric:exponent");
					}

					if (/\d\.\d/u.test(text)) {
						add("Numeric:decimal");
					}
				}

				break;
			}

			case Kind.BigIntLiteral:
				add("BigInt");
				break;
			case Kind.RegularExpressionLiteral: {
				add("Regex");
				const text = node.getText(sf);
				const flags = text.slice(text.lastIndexOf("/") + 1);

				for (const flag of flags) {
					add(`Regex:flag:${flag}`);
				}

				if (text.includes("[")) {
					add("Regex:class");
				}

				if (/\\[pPu]/u.test(text)) {
					add("Regex:unicodeEscape");
				}

				if (/\(\?</u.test(text)) {
					add("Regex:namedGroup|lookbehind");
				}

				break;
			}

			case Kind.StringLiteral: {
				const text = node.getText(sf);

				if (text.includes("\\")) {
					add("String:escape");
				}

				if (/\\\r?\n/u.test(text)) {
					add("String:lineContinuation");
				}

				if (/\\u\{/u.test(text)) {
					add("String:codePointEscape");
				}

				if (/\\u[0-9a-fA-F]{4}/u.test(text)) {
					add("String:unicodeEscape");
				}

				if (/\\x/u.test(text)) {
					add("String:hexEscape");
				}

				if (/\\[0-7]/u.test(text)) {
					add("String:octalEscape");
				}

				if (/[^\x00-\x7F]/u.test(text)) {
					add("String:nonAscii");
				}

				if (node.parent?.kind === Kind.ExpressionStatement) {
					add("Directive");
				}

				break;
			}

			case Kind.ForOfStatement:
				add(node.awaitModifier ? "ForAwaitOf" : "ForOf");
				break;
			case Kind.ForInStatement:
				add("ForIn");
				break;
			case Kind.ForStatement:
				add("For");
				if (!node.initializer && !node.condition && !node.incrementor) {
					add("For:empty");
				}

				break;
			case Kind.LabeledStatement:
				add("Labeled");
				break;
			case Kind.SwitchStatement:
				add("Switch");
				break;
			case Kind.DoStatement:
				add("DoWhile");
				break;
			case Kind.WhileStatement:
				add("While");
				break;
			case Kind.IfStatement:
				add(node.elseStatement ? "If:else" : "If");
				break;
			case Kind.TryStatement: {
				let tryLabel;

				if (node.finallyBlock) {
					tryLabel = node.catchClause ? "Try:catch:finally" : "Try:finally";
				} else {
					tryLabel = "Try:catch";
				}

				add(tryLabel);
				break;
			}

			case Kind.CatchClause:
				if (!node.variableDeclaration) {
					add("OptionalCatchBinding");
				}

				break;
			case Kind.WithStatement:
				add("With");
				break;
			case Kind.DebuggerStatement:
				add("Debugger");
				break;
			case Kind.EmptyStatement:
				add("EmptyStatement");
				break;
			case Kind.ConditionalExpression:
				add("Conditional");
				break;
			case Kind.ParenthesizedExpression:
				add("Parenthesized");
				break;
			case Kind.Block:
				if (node.parent && [Kind.Block, Kind.SourceFile, Kind.CaseClause, Kind.DefaultClause].includes(node.parent.kind)) {
					add("BlockStatement");
				}

				break;
			case Kind.VariableDeclarationList: {
				const flags = node.flags;
				let declKind;

				if (flags & ts.NodeFlags.Const) {
					declKind = "const";
				} else if (flags & ts.NodeFlags.Let) {
					declKind = "let";
				} else if (flags & ts.NodeFlags.Using) {
					declKind = "using";
				} else {
					declKind = "var";
				}

				add(declKind);
				if (node.declarations.length > 1) {
					add("MultiDeclarator");
				}

				if (node.declarations.some((decl) => !decl.initializer)) {
					add("Declarator:noInit");
				}

				break;
			}

			case Kind.Parameter:
				if (node.dotDotDotToken) {
					add("RestParam");
				}

				if (node.initializer) {
					add("DefaultParam");
				}

				if (node.name?.kind === Kind.Identifier && node.name.text === "this") {
					add("ThisParam");
				}

				break;
			case Kind.ObjectLiteralExpression:
				add(node.properties.length ? "ObjectLiteral" : "ObjectLiteral:empty");
				if (trailingComma(node.properties)) {
					add("TrailingComma:object");
				}

				break;
			case Kind.ArrayLiteralExpression:
				add(node.elements.length ? "ArrayLiteral" : "ArrayLiteral:empty");
				if (trailingComma(node.elements)) {
					add("TrailingComma:array");
				}

				break;
			case Kind.ThisKeyword:
				add("this");
				break;
			case Kind.SuperKeyword:
				add("super");
				break;
			case Kind.NullKeyword:
				add("null");
				break;
			case Kind.TrueKeyword:
			case Kind.FalseKeyword:
				add("boolean");
				break;
			case Kind.ReturnStatement:
				add(node.expression ? "Return" : "Return:bare");
				break;
			case Kind.ThrowStatement:
				add("Throw");
				break;
			case Kind.BreakStatement:
				add(node.label ? "Break:label" : "Break");
				break;
			case Kind.ContinueStatement:
				add(node.label ? "Continue:label" : "Continue");
				break;
			case Kind.ImportDeclaration:
			case Kind.ExportDeclaration:
			case Kind.ExportAssignment:
				add("Module");
				break;
			case Kind.SemicolonClassElement:
				add("Class:semicolonMember");
				break;
			// no default
		}

		// TypeScript-only parts, tagged by site
		if (TS_ONLY_KINDS.has(node.kind)) {
			add(`TS:${ts.SyntaxKind[node.kind]}`);
		}

		if (node.type !== undefined && node.kind !== Kind.ConditionalExpression && !TS_ONLY_KINDS.has(node.kind)) {
			add(`TS:Type@${ts.SyntaxKind[node.kind]}`);
		}

		if (node.typeArguments !== undefined) {
			add(`TS:TypeArgs@${ts.SyntaxKind[node.kind]}`);
		}

		if (node.typeParameters !== undefined) {
			add(`TS:TypeParams@${ts.SyntaxKind[node.kind]}`);
		}

		if (node.kind === Kind.HeritageClause && node.token === Kind.ImplementsKeyword) {
			add("TS:implements");
		}

		if (node.questionToken !== undefined && node.kind !== Kind.ConditionalExpression && node.kind !== Kind.ConditionalType) {
			add(`TS:Optional@${ts.SyntaxKind[node.kind]}`);
		}

		if (node.exclamationToken !== undefined) {
			add(`TS:Definite@${ts.SyntaxKind[node.kind]}`);
		}

		if (ts.canHaveModifiers(node)) {
			for (const modifier of ts.getModifiers(node) ?? []) {
				if (TS_ONLY_MODIFIERS.has(modifier.kind) || (modifier.kind === Kind.ConstKeyword && node.kind !== Kind.VariableStatement)) {
					add(`TS:mod:${ts.tokenToString(modifier.kind)}`);
				}
			}
		}

		if (ts.canHaveModifiers(node) && hasMod(node, Kind.ExportKeyword)) {
			add("Module");
		}

		ts.forEachChild(node, visit);
	};

	visit(root);

	return out;
}

// Unicode built from code points so this source stays ASCII.
const ch = (code) => String.fromCharCode(code);
const LINE_SEPARATORS = new RegExp(`[${ch(0x2028)}${ch(0x2029)}]`, "u");
const NEXT_LINE = ch(0x85);
const UNICODE_SPACES = new RegExp(`[${ch(0xA0)}${ch(0xFEFF)}${ch(0x2000)}-${ch(0x200B)}${ch(0x3000)}]`, "u");

/** Features of the raw text that no AST node carries. */
export function textFeatures(source) {
	const out = new Set();

	if (source.charCodeAt(0) === 0xFEFF) {
		out.add("BOM");
	}

	if (source.startsWith("#!")) {
		out.add("Hashbang");
	}

	if (source.includes("\r\n")) {
		out.add("CRLF");
	} else if (source.includes("\r")) {
		out.add("CR");
	}

	if (LINE_SEPARATORS.test(source)) {
		out.add("LS/PS");
	}

	if (source.includes(NEXT_LINE)) {
		out.add("NEL");
	}

	if (/<!--|^-->/mu.test(source)) {
		out.add("HTMLComment");
	}

	if (source.includes("/*")) {
		out.add("Comment:block");
	}

	if (/\/\//u.test(source)) {
		out.add("Comment:line");
	}

	if (/\t/u.test(source)) {
		out.add("Tab");
	}

	if (UNICODE_SPACES.test(source.slice(1))) {
		out.add("UnicodeSpace");
	}

	if (source.length && !/\n$/u.test(source)) {
		out.add("NoTrailingNewline");
	}

	if (source.trim() === "") {
		out.add("EmptyFile");
	}

	return out;
}

/** The top-level statement whose full range (leading trivia included) contains `pos`; null at EOF. */
export function statementAt(sf, pos) {
	for (const statement of sf.statements) {
		if (pos < statement.end) {
			return statement;
		}
	}

	return null;
}
