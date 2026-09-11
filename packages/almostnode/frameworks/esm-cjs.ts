/**
 * ESM→CJS source transform (acorn-based), split out of code-transforms.ts so the runtime can use it without
 * pulling in the CSS-modules helper (generateCssModuleReplacement), which is the only css-tree consumer.
 * This is the ONLY thing runtime.ts needs from the old code-transforms module; keeping it here lets rolldown
 * drop code-transforms.ts (and css-tree) from the graph entirely.
 *
 * Verbatim extraction of transformEsmToCjsSimple + its private helpers from
 * frameworks/code-transforms.ts (macaly/almostnode@0.2.14, MIT).
 */

import * as acorn from "acorn";

/**
 * ESM to CJS transform using acorn AST parsing.
 * Used in non-browser (test) environments where esbuild is unavailable.
 * Falls back to regex if acorn fails to parse.
 */
export function transformEsmToCjsSimple(code: string): string {
  try {
    return transformEsmToCjsAst(code);
  } catch {
    return transformEsmToCjsRegex(code);
  }
}

/** AST-based ESM→CJS transform using acorn. */
function transformEsmToCjsAst(code: string): string {
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });

  // Collect replacements as [start, end, replacement] sorted by start descending
  const replacements: Array<[number, number, string]> = [];

  for (const node of (ast as any).body) {
    if (node.type === 'ImportDeclaration') {
      const source = node.source.value;
      const specs = node.specifiers;

      if (specs.length === 0) {
        // Side-effect import: import './polyfill'
        replacements.push([node.start, node.end, `require(${JSON.stringify(source)})`]);
      } else {
        const defaultSpec = specs.find((s: any) => s.type === 'ImportDefaultSpecifier');
        const nsSpec = specs.find((s: any) => s.type === 'ImportNamespaceSpecifier');
        const namedSpecs = specs.filter((s: any) => s.type === 'ImportSpecifier');

        const parts: string[] = [];
        if (defaultSpec) {
          parts.push(`const ${defaultSpec.local.name} = require(${JSON.stringify(source)})`);
        }
        if (nsSpec) {
          parts.push(`const ${nsSpec.local.name} = require(${JSON.stringify(source)})`);
        }
        if (namedSpecs.length > 0) {
          const bindings = namedSpecs.map((s: any) => {
            if (s.imported.name === s.local.name) return s.local.name;
            return `${s.imported.name}: ${s.local.name}`;
          }).join(', ');
          if (defaultSpec) {
            // Mixed: import React, { useState } from 'react'
            // Default already handled, just destructure from same require
            parts.push(`const { ${bindings} } = require(${JSON.stringify(source)})`);
          } else {
            parts.push(`const { ${bindings} } = require(${JSON.stringify(source)})`);
          }
        }
        replacements.push([node.start, node.end, parts.join(';\n')]);
      }
    } else if (node.type === 'ExportDefaultDeclaration') {
      const decl = node.declaration;
      if (decl.type === 'FunctionDeclaration') {
        // export default function X() {} → module.exports = function X() {}
        const funcCode = code.slice(decl.start, node.end);
        replacements.push([node.start, node.end, `module.exports = ${funcCode}`]);
      } else if (decl.type === 'ClassDeclaration') {
        const classCode = code.slice(decl.start, node.end);
        replacements.push([node.start, node.end, `module.exports = ${classCode}`]);
      } else {
        // export default <expression>
        const exprCode = code.slice(decl.start, node.end);
        replacements.push([node.start, node.end, `module.exports = ${exprCode}`]);
      }
    } else if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) {
        const decl = node.declaration;
        if (decl.type === 'FunctionDeclaration') {
          const name = decl.id.name;
          const funcCode = code.slice(decl.start, node.end);
          replacements.push([node.start, node.end, `exports.${name} = ${funcCode}`]);
        } else if (decl.type === 'ClassDeclaration') {
          const name = decl.id.name;
          const classCode = code.slice(decl.start, node.end);
          replacements.push([node.start, node.end, `exports.${name} = ${classCode}`]);
        } else if (decl.type === 'VariableDeclaration') {
          // export const X = ..., export let Y = ...
          const parts: string[] = [];
          for (const declarator of decl.declarations) {
            const name = declarator.id.name;
            const initCode = declarator.init ? code.slice(declarator.init.start, declarator.init.end) : 'undefined';
            parts.push(`exports.${name} = ${initCode}`);
          }
          replacements.push([node.start, node.end, parts.join(';\n')]);
        }
      } else if (node.source) {
        // Re-export: export { X } from './module'
        const source = node.source.value;
        const parts: string[] = [];
        const tmpVar = `__reexport_${node.start}`;
        parts.push(`const ${tmpVar} = require(${JSON.stringify(source)})`);
        for (const spec of node.specifiers) {
          parts.push(`exports.${spec.exported.name} = ${tmpVar}.${spec.local.name}`);
        }
        replacements.push([node.start, node.end, parts.join(';\n')]);
      } else {
        // Local re-export: export { foo, bar }
        const parts: string[] = [];
        for (const spec of node.specifiers) {
          parts.push(`exports.${spec.exported.name} = ${spec.local.name}`);
        }
        replacements.push([node.start, node.end, parts.join(';\n')]);
      }
    } else if (node.type === 'ExportAllDeclaration') {
      // export * from './helpers'
      const source = node.source.value;
      replacements.push([node.start, node.end, `Object.assign(exports, require(${JSON.stringify(source)}))`]);
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

/** Regex-based ESM→CJS fallback for code acorn can't parse. */
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
