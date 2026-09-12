/**
 * ESM→CJS source transform, split out of code-transforms.ts so the runtime can use it without pulling in the
 * CSS-modules helper (generateCssModuleReplacement), which is the only css-tree consumer. This is the ONLY
 * thing runtime.ts needs from the old code-transforms module; keeping it here lets rolldown drop
 * code-transforms.ts (and css-tree) from the graph entirely.
 *
 * Derived from transformEsmToCjsSimple + its private helpers in frameworks/code-transforms.ts
 * (macaly/almostnode@0.2.14, MIT), but re-pointed off acorn onto the TypeScript AST — the editor already
 * ships `typescript` (the dev-server transpiler, tsval, preflight, the tsserver worker), so this reuses that
 * one parser instead of bundling a second one just for these transforms.
 */

import ts from "typescript";

/**
 * ESM to CJS transform using the TypeScript AST.
 * Used in non-browser (test) environments where esbuild is unavailable.
 * Falls back to regex if the AST walk throws on an unexpected shape.
 */
export function transformEsmToCjsSimple(code: string): string {
  try {
    return transformEsmToCjsAst(code);
  } catch {
    return transformEsmToCjsRegex(code);
  }
}

/** Modifiers a statement carries (`export`, `default`, `async`, …), or `undefined` for nodes that can't. */
function modifiersOf(node: ts.Node): readonly ts.Modifier[] | undefined {
  return ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return modifiersOf(node)?.some((modifier) => modifier.kind === kind) ?? false;
}

/**
 * A declaration's source text with its leading `export`/`default` modifiers stripped, so
 * `export default async function X() {}` becomes `async function X() {}`. `export`/`default` always precede
 * any other modifier, so walking past them from the front and slicing the remainder is sufficient.
 */
function stripLeadingExportModifiers(node: ts.Node, sourceFile: ts.SourceFile, code: string): string {
  let sliceFrom = node.getStart(sourceFile);

  for (const modifier of modifiersOf(node) ?? []) {
    if (modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword) {
      sliceFrom = modifier.getEnd();
    } else {
      break;
    }
  }

  return code.slice(sliceFrom, node.getEnd()).replace(/^\s+/u, "");
}

/** AST-based ESM→CJS transform over the TypeScript AST. */
function transformEsmToCjsAst(code: string): string {
  // ScriptKind.TSX parses the JS/JSX/TS superset the runtime may hand us; only top-level statements can carry
  // import/export declarations, so a shallow scan of sourceFile.statements matches acorn's `ast.body` walk.
  const sourceFile = ts.createSourceFile("module.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  // Collect replacements as [start, end, replacement] sorted by start descending
  const replacements: Array<[number, number, string]> = [];

  for (const node of sourceFile.statements) {
    const start = node.getStart(sourceFile);
    const end = node.getEnd();

    if (ts.isImportDeclaration(node)) {
      // `import type …` is a type-only import — nothing to require at runtime. (Transpiled JS won't carry
      // these, but the runtime can be handed raw TS, so drop them rather than emit `require()`.)
      if (node.importClause?.isTypeOnly) {
        replacements.push([start, end, ""]);
        continue;
      }

      const source = (node.moduleSpecifier as ts.StringLiteral).text;
      const clause = node.importClause;

      if (clause === undefined) {
        // Side-effect import: import './polyfill'
        replacements.push([start, end, `require(${JSON.stringify(source)})`]);
        continue;
      }

      const parts: string[] = [];

      if (clause.name !== undefined) {
        // Default import: import React from 'react'
        parts.push(`const ${clause.name.text} = require(${JSON.stringify(source)})`);
      }

      const bindings = clause.namedBindings;

      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        // Namespace import: import * as ns from 'x'
        parts.push(`const ${bindings.name.text} = require(${JSON.stringify(source)})`);
      } else if (bindings !== undefined && ts.isNamedImports(bindings)) {
        const named = bindings.elements
          .filter((element) => !element.isTypeOnly)
          .map((element) => {
            const imported = (element.propertyName ?? element.name).text;
            const local = element.name.text;

            return imported === local ? local : `${imported}: ${local}`;
          });

        if (named.length > 0) {
          parts.push(`const { ${named.join(", ")} } = require(${JSON.stringify(source)})`);
        }
      }

      replacements.push([start, end, parts.join(";\n")]);
    } else if (ts.isExportAssignment(node) && node.isExportEquals !== true) {
      // export default <expression>
      const exprCode = code.slice(node.expression.getStart(sourceFile), node.expression.getEnd());
      replacements.push([start, end, `module.exports = ${exprCode}`]);
    } else if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly) {
        replacements.push([start, end, ""]);
        continue;
      }

      const clause = node.exportClause;

      if (node.moduleSpecifier !== undefined) {
        const source = (node.moduleSpecifier as ts.StringLiteral).text;

        if (clause === undefined) {
          // export * from './helpers'
          replacements.push([start, end, `Object.assign(exports, require(${JSON.stringify(source)}))`]);
        } else if (ts.isNamespaceExport(clause)) {
          // export * as ns from './helpers'
          replacements.push([start, end, `exports.${clause.name.text} = require(${JSON.stringify(source)})`]);
        } else {
          // Re-export: export { X, Y as Z } from './module'
          const tmpVar = `__reexport_${start}`;
          const parts = [`const ${tmpVar} = require(${JSON.stringify(source)})`];

          for (const spec of clause.elements) {
            if (spec.isTypeOnly) {
              continue;
            }

            // ExportSpecifier: `.name` is the EXPORTED name, `.propertyName` the LOCAL one (when aliased).
            parts.push(`exports.${spec.name.text} = ${tmpVar}.${(spec.propertyName ?? spec.name).text}`);
          }

          replacements.push([start, end, parts.join(";\n")]);
        }
      } else if (clause !== undefined && ts.isNamedExports(clause)) {
        // Local re-export: export { foo, bar as baz }
        const parts: string[] = [];

        for (const spec of clause.elements) {
          if (spec.isTypeOnly) {
            continue;
          }

          parts.push(`exports.${spec.name.text} = ${(spec.propertyName ?? spec.name).text}`);
        }

        replacements.push([start, end, parts.join(";\n")]);
      }
    } else if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      // A declaration carrying an `export` modifier: export [default] function/class/const.
      const isDefault = hasModifier(node, ts.SyntaxKind.DefaultKeyword);

      if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
        const declCode = stripLeadingExportModifiers(node, sourceFile, code);

        if (isDefault) {
          // export default function X() {} → module.exports = function X() {}
          replacements.push([start, end, `module.exports = ${declCode}`]);
        } else if (node.name !== undefined) {
          replacements.push([start, end, `exports.${node.name.text} = ${declCode}`]);
        }
      } else if (ts.isVariableStatement(node)) {
        // export const X = ..., export let Y = ...
        const parts: string[] = [];

        for (const declarator of node.declarationList.declarations) {
          if (!ts.isIdentifier(declarator.name)) {
            continue; // binding patterns (export const { a } = x) aren't handled — matches the old behavior
          }

          const initCode = declarator.initializer
            ? code.slice(declarator.initializer.getStart(sourceFile), declarator.initializer.getEnd())
            : "undefined";
          parts.push(`exports.${declarator.name.text} = ${initCode}`);
        }

        replacements.push([start, end, parts.join(";\n")]);
      }
    }
  }

  // Apply replacements from end to start to preserve positions
  let result = code;
  replacements.sort((a, b) => b[0] - a[0]);
  for (const [start, end, replacement] of replacements) {
    result = result.slice(0, start) + replacement + result.slice(end);
  }

  return result;
}

/** Regex-based ESM→CJS fallback for when the AST walk throws. */
function transformEsmToCjsRegex(code: string): string {
  let transformed = code;

  transformed = transformed.replace(
    /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g,
    'const $1 = require("$2")',
  );
  transformed = transformed.replace(
    /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g,
    'const {$1} = require("$2")',
  );
  transformed = transformed.replace(
    /export\s+default\s+function\s+(\w+)/g,
    'module.exports = function $1',
  );
  transformed = transformed.replace(
    /export\s+default\s+function\s*\(/g,
    'module.exports = function(',
  );
  transformed = transformed.replace(
    /export\s+default\s+/g,
    'module.exports = ',
  );
  transformed = transformed.replace(
    /export\s+async\s+function\s+(\w+)/g,
    'exports.$1 = async function $1',
  );
  transformed = transformed.replace(
    /export\s+function\s+(\w+)/g,
    'exports.$1 = function $1',
  );
  transformed = transformed.replace(
    /export\s+const\s+(\w+)\s*=/g,
    'exports.$1 =',
  );

  return transformed;
}
