import ts from 'typescript';
import type { SourceComponentExport } from './sourceComponentExports.js';

export function isStorybookSourcePath(filePath: string): boolean {
  return /\.(stories|story)\.[cm]?[jt]sx?$/i.test(filePath);
}

/** CSF discovery is static. Only the isolated preview evaluates project code. */
export function discoverStorybookExports(source: string, filePath: string): SourceComponentExport[] {
  const file = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const locals = new Map<string, ts.Expression>();
  const names: string[] = [];
  let meta: ts.Expression | undefined;
  const unwrap = (value: ts.Expression): ts.Expression => {
    while (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value)) value = value.expression;
    return value;
  };
  for (const statement of file.statements) {
    const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      locals.set(declaration.name.text, unwrap(declaration.initializer));
      if (exported) names.push(declaration.name.text);
    }
    if (ts.isFunctionDeclaration(statement) && exported && statement.name) names.push(statement.name.text);
    if (ts.isExportAssignment(statement)) meta = unwrap(statement.expression);
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const item of statement.exportClause.elements) if (!item.isTypeOnly) names.push(item.name.text);
    }
  }
  if (meta && ts.isIdentifier(meta)) meta = locals.get(meta.text);
  if (!meta) return [];
  const filters = new Map<string, ts.Expression>();
  if (ts.isObjectLiteralExpression(meta)) for (const property of meta.properties) {
    if (ts.isPropertyAssignment(property)) filters.set(property.name.getText(file).replace(/^["']|["']$/g, ''), unwrap(property.initializer));
  }
  function matches(filter: ts.Expression | undefined, name: string): boolean | undefined {
    if (!filter) return undefined;
    if (ts.isArrayLiteralExpression(filter)) return filter.elements.some(item => ts.isStringLiteralLike(item) && item.text === name);
    if (ts.isRegularExpressionLiteral(filter)) {
      const match = /^\/(.*)\/([a-z]*)$/.exec(filter.text);
      if (match) try { return new RegExp(match[1], match[2]).test(name); } catch { return undefined; }
    }
    return undefined;
  }
  return [...new Set(names)].filter(name => name !== 'default' && name !== '__namedExportsOrder'
    && matches(filters.get('includeStories'), name) !== false && matches(filters.get('excludeStories'), name) !== true)
    .map(name => ({ exportName: name, localName: name, declarationId: `${filePath}:${name}` }));
}

export function detectStorybookFramework(source: string, fallback: string | null = null): 'react' | 'vue' | 'svelte' {
  if (/@storybook\/(?:vue3|vue)(?:[/'"]|$)/.test(source) || /from\s*['"][^'"]+\.vue['"]/.test(source)) return 'vue';
  if (/@storybook\/svelte(?:[/'"]|$)/.test(source) || /from\s*['"][^'"]+\.svelte['"]/.test(source)) return 'svelte';
  return fallback === 'vue' || fallback === 'svelte' ? fallback : 'react';
}
