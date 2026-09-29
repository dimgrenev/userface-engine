import ts from 'typescript';

export type SourceComponentExport = {
  exportName: string;
  localName: string;
  /** Stable declaration identity, used to collapse default/named aliases. */
  declarationId: string;
};

type SourceValueExport = SourceComponentExport & { isComponent: boolean };

type ImportedValue = { module: string; name: string };
type ExportBinding = { name: string; value?: ts.Node; local?: string; imported?: ImportedValue };
export type SourceModuleReader = (specifier: string, importer: string) => Promise<{ path: string; source: string } | null>;

function unwrap(node: ts.Node): ts.Node {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
    || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) node = node.expression;
  return node;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name) && !/Props$|Options$|Config$/.test(name);
}

/** Parse source without evaluating workspace JavaScript or loading its config. */
async function discoverSourceValueExports(
  source: string,
  filePath: string,
  readModule?: SourceModuleReader,
  ancestors = new Set<string>(),
): Promise<SourceValueExport[]> {
  if (ancestors.has(filePath)) return [];
  const visiting = new Set(ancestors).add(filePath);
  if (/\.(vue|svelte)$/i.test(filePath)) {
    return [{ exportName: 'default', localName: filePath.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, ''), declarationId: `${filePath}:default`, isComponent: true }];
  }
  const file = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true,
    /\.[cm]?tsx$|\.[cm]?jsx$/i.test(filePath) ? ts.ScriptKind.TSX : /\.[cm]?js$/i.test(filePath) ? ts.ScriptKind.JSX : ts.ScriptKind.TS);
  const locals = new Map<string, ts.Node>();
  const imports = new Map<string, ImportedValue>();
  const exports: ExportBinding[] = [];
  const stars: string[] = [];

  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && !statement.importClause?.isTypeOnly) {
      const clause = statement.importClause;
      const module = statement.moduleSpecifier.text;
      if (clause?.name) imports.set(clause.name.text, { module, name: 'default' });
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const binding of clause.namedBindings.elements) {
          if (!binding.isTypeOnly) imports.set(binding.name.text, { module, name: binding.propertyName?.text || binding.name.text });
        }
      }
    }
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      locals.set(statement.name.text, statement);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        locals.set(declaration.name.text, declaration.initializer);
        if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) exports.push({ name: declaration.name.text, local: declaration.name.text });
      }
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      exports.push({ name: hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default' : statement.name?.text || 'default', value: statement, local: statement.name?.text });
    } else if (ts.isExportAssignment(statement)) {
      const value = unwrap(statement.expression);
      exports.push({ name: 'default', value, ...(ts.isIdentifier(value) ? { local: value.text } : {}) });
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const module = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null;
      if (!statement.exportClause && module) stars.push(module);
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const binding of statement.exportClause.elements) {
          if (binding.isTypeOnly) continue;
          const name = binding.propertyName?.text || binding.name.text;
          exports.push({ name: binding.name.text, ...(module ? { imported: { module, name } } : { local: name }) });
        }
      }
    } else if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
      && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = statement.expression.left.getText(file);
      const match = /^(?:module\.)?exports\.([\w$]+)$/.exec(left);
      if (left === 'module.exports' || match) exports.push({ name: match?.[1] || 'default', value: statement.expression.right });
    }
  }

  const modules = new Map<string, Promise<SourceValueExport[] | null>>();
  function moduleExports(specifier: string): Promise<SourceValueExport[] | null> {
    if (!modules.has(specifier)) modules.set(specifier, (async () => {
      const resolved = await readModule?.(specifier, filePath);
      return resolved ? discoverSourceValueExports(resolved.source, resolved.path, readModule, visiting) : null;
    })());
    return modules.get(specifier)!;
  }

  function renders(node: ts.Node, name: string, seen = new Set<ts.Node>()): boolean {
    node = unwrap(node);
    if (seen.has(node)) return false;
    const nextSeen = new Set(seen).add(node);
    if (ts.isIdentifier(node)) {
      const local = locals.get(node.text);
      return local ? renders(local, name, nextSeen) : imports.has(node.text) ? isComponentName(node.text) : isComponentName(name) || name === 'default';
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return isComponentName(name) || name === 'default';
    if (ts.isAwaitExpression(node)) return renders(node.expression, name, nextSeen) || isComponentName(name) || name === 'default';
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return isComponentName(name) || name === 'default';
    if (ts.isConditionalExpression(node)) return renders(node.whenTrue, name, nextSeen) || renders(node.whenFalse, name, nextSeen);
    if (ts.isBinaryExpression(node)) return renders(node.left, name, nextSeen) || renders(node.right, name, nextSeen);
    if (ts.isArrayLiteralExpression(node)) return node.elements.some((element) => renders(element, name, nextSeen));
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.NullKeyword) return isComponentName(name) || name === 'default';
    if (ts.isTaggedTemplateExpression(node)) return /^styled(?:\.|\()/.test(node.tag.getText(file));
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file);
      if (/(?:^|\.)(?:createElement|jsx|jsxs|jsxDEV)$/.test(callee)) return true;
      if (/^styled(?:\.|\()/.test(callee)) return true;
      if (/(?:^|\.)(?:memo|forwardRef|observer|lazy|connect)$/.test(callee)) {
        return isComponentName(name) || name === 'default' || node.arguments.some((argument) => renders(argument, name, nextSeen));
      }
      // User-defined HOCs can wrap a component, but arbitrary utility calls
      // such as cva('...') are not evidence of a component.
      return node.arguments.some((argument) => (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument) || ts.isIdentifier(argument)) && renders(argument, name, nextSeen));
    }
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
      if (!node.body || /^use[A-Z]/.test(name)) return false;
      if (!ts.isBlock(node.body)) return renders(node.body, name, nextSeen);
      let result = false;
      const visit = (child: ts.Node): void => {
        if (ts.isReturnStatement(child)) { result ||= Boolean(child.expression && renders(child.expression, name, nextSeen)); return; }
        if (ts.isFunctionLike(child) || ts.isClassLike(child)) return;
        ts.forEachChild(child, visit);
      };
      ts.forEachChild(node.body, visit);
      return result;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      return node.members.some((member) => ts.isMethodDeclaration(member) && member.name.getText(file) === 'render' && renders(member, name, nextSeen));
    }
    return false;
  }

  const result: SourceValueExport[] = [];
  for (const binding of exports) {
    const localName = binding.local || (binding.value && 'name' in binding.value && binding.value.name && ts.isIdentifier(binding.value.name as ts.Node) ? (binding.value.name as ts.Identifier).text : binding.name);
    const imported = binding.imported || (binding.local ? imports.get(binding.local) : undefined);
    if (imported) {
      const resolved = await moduleExports(imported.module);
      const target = resolved?.find((entry) => entry.exportName === imported.name);
      if (target) result.push({ ...target, exportName: binding.name });
      // Package reexports remain candidates; Vite resolves the real value in
      // the workspace's installed package. Relative missing modules do not.
      else if (resolved === null && !imported.module.startsWith('.') && isComponentName(localName)) {
        result.push({ exportName: binding.name, localName, declarationId: `${imported.module}:${imported.name}`, isComponent: true });
      }
      continue;
    }
    const value = binding.value || (binding.local ? locals.get(binding.local) : undefined);
    if (value) {
      const unwrapped = unwrap(value);
      const primitive = ts.isStringLiteralLike(unwrapped) || ts.isNumericLiteral(unwrapped)
        || [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(unwrapped.kind);
      result.push({
        exportName: binding.name, localName, declarationId: `${filePath}:${binding.local || value.pos}`,
        isComponent: !primitive && renders(value, binding.name),
      });
    }
  }
  const explicitNames = new Set(exports.map(binding => binding.name));
  const starExports = new Map<string, SourceValueExport | null>();
  for (const specifier of stars) {
    for (const entry of await moduleExports(specifier) || []) {
      if (entry.exportName === 'default' || explicitNames.has(entry.exportName)) continue;
      if (!starExports.has(entry.exportName)) starExports.set(entry.exportName, entry);
      else if (starExports.get(entry.exportName)?.declarationId !== entry.declarationId) starExports.set(entry.exportName, null);
    }
  }
  for (const entry of starExports.values()) if (entry) result.push(entry);
  return result;
}

/** Keep non-component exports until star conflicts have been resolved. */
export async function discoverSourceComponentExports(
  source: string,
  filePath: string,
  readModule?: SourceModuleReader,
  ancestors = new Set<string>(),
): Promise<SourceComponentExport[]> {
  const entries = await discoverSourceValueExports(source, filePath, readModule, ancestors);
  return entries.filter(entry => entry.isComponent).map(({ isComponent, ...entry }) => entry);
}

export function orderSourceComponentExports(entries: SourceComponentExport[], fileName: string): SourceComponentExport[] {
  const score = (entry: SourceComponentExport) => entry.exportName === 'default' ? 0 : entry.exportName.toLowerCase() === fileName.toLowerCase() ? 1 : 2;
  const seen = new Set<string>();
  return [...entries].sort((a, b) => score(a) - score(b)).filter((entry) => {
    if (seen.has(entry.declarationId)) return false;
    seen.add(entry.declarationId);
    return true;
  });
}
