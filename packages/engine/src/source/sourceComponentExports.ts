import ts from 'typescript';
import { createSourceRenderRoleAnalyzer } from './sourceRenderRole.js';

export type SourceComponentExport = {
  exportName: string;
  localName: string;
  /** Stable declaration identity, used to collapse default/named aliases. */
  declarationId: string;
  /** Import binding anchored at its source module; never proof of an external declaration. */
  bindingId?: string;
  /** Proven render shape, independent of props/default state. Unknown stays absent. */
  renderRole?: 'nonvisual' | 'provider';
};

type SourceValueExport = SourceComponentExport & { isComponent: boolean; isNodeValue: boolean; isContext?: boolean };

function sourceExportIdentity(entry: SourceComponentExport): string {
  return JSON.stringify(entry.bindingId ? ['binding', entry.bindingId] : ['declaration', entry.declarationId]);
}

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
  requestedExportName?: string,
): Promise<SourceValueExport[]> {
  if (ancestors.has(filePath)) return [];
  const visiting = new Set(ancestors).add(filePath);
  if (/\.(vue|svelte)$/i.test(filePath)) {
    if (requestedExportName !== undefined && requestedExportName !== 'default') return [];
    return [{ exportName: 'default', localName: filePath.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, ''), declarationId: `${filePath}:default`, isComponent: true, isNodeValue: false }];
  }
  const file = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true,
    /\.[cm]?tsx$|\.[cm]?jsx$/i.test(filePath) ? ts.ScriptKind.TSX : /\.[cm]?js$/i.test(filePath) ? ts.ScriptKind.JSX : ts.ScriptKind.TS);
  const locals = new Map<string, ts.Node>();
  const typeAliases = new Map<string, ts.TypeNode>();
  const interfaces = new Map<string, ts.InterfaceDeclaration>();
  const localTypes = new Map<string, ts.TypeNode>();
  const imports = new Map<string, ImportedValue>();
  const namespaces = new Map<string, string>();
  const destructured = new Map<string, { value: ts.Expression; name: string }>();
  const exports: ExportBinding[] = [];
  const stars: string[] = [];

  for (const statement of file.statements) {
    if (ts.isTypeAliasDeclaration(statement)) typeAliases.set(statement.name.text, statement.type);
    if (ts.isInterfaceDeclaration(statement)) interfaces.set(statement.name.text, statement);
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && !statement.importClause?.isTypeOnly) {
      const clause = statement.importClause;
      const module = statement.moduleSpecifier.text;
      if (clause?.name) imports.set(clause.name.text, { module, name: 'default' });
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const binding of clause.namedBindings.elements) {
          if (!binding.isTypeOnly) imports.set(binding.name.text, { module, name: binding.propertyName?.text || binding.name.text });
        }
      }
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
        namespaces.set(clause.namedBindings.name.text, module);
    }
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      locals.set(statement.name.text, statement);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isObjectBindingPattern(declaration.name) && declaration.initializer) {
          for (const binding of declaration.name.elements) {
            if (!ts.isIdentifier(binding.name) || binding.dotDotDotToken || binding.initializer) continue;
            const key = binding.propertyName || binding.name;
            if (ts.isIdentifier(key) || ts.isStringLiteral(key))
              destructured.set(binding.name.text, { value: declaration.initializer, name: key.text });
          }
        }
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        locals.set(declaration.name.text, declaration.initializer);
        if (declaration.type) localTypes.set(declaration.name.text, declaration.type);
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
  const moduleSources = new Map<string, ReturnType<SourceModuleReader>>();
  function moduleExports(specifier: string, exportName?: string): Promise<SourceValueExport[] | null> {
    const key = JSON.stringify([specifier, exportName]);
    if (!modules.has(key)) modules.set(key, (async () => {
      if (!moduleSources.has(specifier)) moduleSources.set(specifier, (async () => await readModule?.(specifier, filePath) ?? null)());
      const resolved = await moduleSources.get(specifier)!;
      return resolved ? discoverSourceValueExports(resolved.source, resolved.path, readModule, visiting, exportName) : null;
    })());
    return modules.get(key)!;
  }

  function binds(name: ts.BindingName, value: string): boolean {
    return ts.isIdentifier(name) ? name.text === value
      : name.elements.some(element => ts.isBindingElement(element) && binds(element.name, value));
  }

  function typeMember(type: ts.TypeNode | undefined, key: string, seen = new Set<string>()): ts.TypeNode | undefined {
    if (!type) return undefined;
    if (ts.isParenthesizedTypeNode(type)) return typeMember(type.type, key, seen);
    if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && !seen.has(type.typeName.text)) {
      const name = type.typeName.text;
      const nextSeen = new Set(seen).add(name);
      const alias = typeAliases.get(name);
      if (alias) return typeMember(alias, key, nextSeen);
      const declaration = interfaces.get(name);
      const member = declaration?.members.find(member => member.name && propertyKey(member.name) === key);
      return member && ts.isPropertySignature(member) ? member.type : undefined;
    }
    if (ts.isTypeLiteralNode(type)) {
      const member = type.members.find(member => member.name && propertyKey(member.name) === key);
      return member && ts.isPropertySignature(member) ? member.type : undefined;
    }
    return undefined;
  }

  function bindingType(name: ts.BindingName, value: string, type?: ts.TypeNode): ts.TypeNode | undefined {
    if (ts.isIdentifier(name)) return name.text === value ? type : undefined;
    if (ts.isObjectBindingPattern(name)) {
      for (const binding of name.elements) {
        if (!binds(binding.name, value) || binding.dotDotDotToken) continue;
        const key = propertyKey(binding.propertyName || binding.name);
        return key === undefined ? undefined : bindingType(binding.name, value, typeMember(type, key));
      }
    }
    return undefined;
  }

  /** Resolve only lexical declarations, never execute an initializer. An
   * unknown parameter/destructured binding still shadows a module import. */
  function lexicalValue(node: ts.Identifier): { value?: ts.Node; type?: ts.TypeNode; parameter?: ts.ParameterDeclaration } | undefined {
    for (let scope: ts.Node | undefined = node.parent; scope && !ts.isSourceFile(scope); scope = scope.parent) {
      if (ts.isBlock(scope)) for (const statement of scope.statements) {
        if (ts.isVariableStatement(statement)) {
          const declaration = statement.declarationList.declarations.find(value => binds(value.name, node.text));
          if (declaration) return ts.isIdentifier(declaration.name)
            ? { value: declaration.initializer, type: declaration.type }
            : { type: bindingType(declaration.name, node.text, declaration.type) };
        }
        if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === node.text)
          return { value: statement };
      }
      if (ts.isFunctionLike(scope)) {
        const parameter = scope.parameters.find(parameter => binds(parameter.name, node.text));
        if (parameter) return { type: bindingType(parameter.name, node.text, parameter.type), parameter };
      }
      if ((ts.isFunctionExpression(scope) || ts.isClassExpression(scope)) && scope.name?.text === node.text) return { value: scope };
      if (ts.isCatchClause(scope) && scope.variableDeclaration && binds(scope.variableDeclaration.name, node.text)) return {};
      if ((ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope))
        && scope.initializer && ts.isVariableDeclarationList(scope.initializer)) {
        const declaration = scope.initializer.declarations.find(value => binds(value.name, node.text));
        if (declaration) return ts.isIdentifier(declaration.name) ? { value: declaration.initializer } : {};
      }
    }
    return undefined;
  }

  // TypeScript emits imported calls as (0, module.factory)(...). Only this
  // value-preserving comma form is transparent; arbitrary comma expressions
  // must not confer React provenance on their result.
  function callTarget(node: ts.Node): ts.Node {
    node = unwrap(node);
    while (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken
      && ts.isNumericLiteral(unwrap(node.left)) && (unwrap(node.left) as ts.NumericLiteral).text === '0') {
      node = unwrap(node.right);
    }
    return node;
  }

  function reactReference(node: ts.Node, seen = new Set<ts.Node>()): { module: string; name: string | null } | null {
    node = callTarget(node);
    if (seen.has(node)) return null;
    const nextSeen = new Set(seen).add(node);
    if (ts.isIdentifier(node)) {
      const lexical = lexicalValue(node);
      if (lexical) return lexical.value ? reactReference(lexical.value, nextSeen) : null;
      const imported = imports.get(node.text);
      if (imported) return { module: imported.module,
        name: imported.module === 'react' && imported.name === 'default' ? null : imported.name };
      const namespace = namespaces.get(node.text);
      if (namespace) return { module: namespace, name: null };
      const binding = destructured.get(node.text);
      if (binding) {
        const owner = reactReference(binding.value, nextSeen);
        return owner?.name === null ? { module: owner.module, name: binding.name } : null;
      }
      const local = locals.get(node.text);
      return local ? reactReference(local, nextSeen) : null;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
      && !hasKnownBinding(node.expression)
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      return { module: node.arguments[0].text, name: null };
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node) ? node.name.text
        : node.argumentExpression && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : null;
      const owner = reactReference(node.expression, nextSeen);
      return key && owner?.name === null ? { module: owner.module, name: key } : null;
    }
    return null;
  }

  function hasKnownBinding(node: ts.Node): boolean {
    node = callTarget(node);
    if (ts.isIdentifier(node)) return Boolean(lexicalValue(node) || locals.has(node.text) || imports.has(node.text)
      || namespaces.has(node.text) || destructured.has(node.text));
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return hasKnownBinding(node.expression);
    return true;
  }

  function isNodeFactory(node: ts.Node): boolean {
    const reference = reactReference(node);
    if (reference) return reference.module === 'react' ? reference.name === 'createElement'
      : reference.module === 'react/jsx-runtime' ? reference.name === 'jsx' || reference.name === 'jsxs'
      : reference.module === 'react/jsx-dev-runtime' && reference.name === 'jsxDEV';
    // Preserve existing unbound host globals (notably React.createElement).
    // A known local/import binding must instead prove its React origin above.
    return !hasKnownBinding(node) && /(?:^|\.)(?:createElement|jsx|jsxs|jsxDEV)$/.test(callTarget(node).getText(file));
  }

  function reactWrapper(node: ts.Node): string | undefined {
    const reference = reactReference(node);
    if (reference?.module === 'react' && reference.name
      && ['memo', 'forwardRef', 'lazy'].includes(reference.name)) return reference.name;
    if (!hasKnownBinding(node)) return /(?:^|\.)(memo|forwardRef|lazy)$/.exec(callTarget(node).getText(file))?.[1];
    return undefined;
  }

  async function importedValue(name: string): Promise<SourceValueExport | null | undefined> {
    const imported = imports.get(name);
    if (!imported) return undefined;
    const resolved = await moduleExports(imported.module, imported.name);
    // Null is a known missing export. Undefined retains the existing unknown
    // package compatibility path when the guarded reader cannot resolve it.
    return resolved === null ? undefined : resolved.find(entry => entry.exportName === imported.name) ?? null;
  }

  async function someNode(nodes: readonly ts.Node[], predicate: (node: ts.Node) => Promise<boolean>): Promise<boolean> {
    for (const node of nodes) if (await predicate(node)) return true;
    return false;
  }

  /** A call returns its callee's result, not any of the values supplied to it.
   * Follow only bounded local aliases; imports and unknown callbacks remain
   * unknown instead of executing authored code or guessing their result. */
  function localFunction(node: ts.Node, seen = new Set<ts.Node>()): ts.FunctionLikeDeclaration | undefined {
    node = callTarget(node);
    if (seen.has(node) || seen.size >= 32) return undefined;
    const nextSeen = new Set(seen).add(node);
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) return node;
    if (ts.isIdentifier(node)) {
      const lexical = lexicalValue(node);
      const value = lexical ? lexical.value : locals.get(node.text);
      return value ? localFunction(value, nextSeen) : undefined;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const value = localMember(node);
      return value ? localFunction(value, nextSeen) : undefined;
    }
    return undefined;
  }

  function propertyKey(node: ts.Node): string | undefined {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
    if (ts.isComputedPropertyName(node) && (ts.isStringLiteralLike(node.expression) || ts.isNumericLiteral(node.expression)))
      return node.expression.text;
    return undefined;
  }

  /** Resolve only explicit local object members. Unknown spreads, accessors,
   * computed keys retain the compatibility
   * path; reading them must never evaluate application code. */
  function localExpression(node: ts.Node, seen = new Set<ts.Node>()): ts.Node | undefined {
    node = unwrap(node);
    if (seen.has(node) || seen.size >= 32) return undefined;
    const nextSeen = new Set(seen).add(node);
    if (ts.isIdentifier(node)) {
      const lexical = lexicalValue(node);
      const value = lexical ? lexical.value : locals.get(node.text);
      return value ? localExpression(value, nextSeen) : node;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const member = localMember(node, nextSeen);
      return member ? localExpression(member, nextSeen) : node;
    }
    return node;
  }

  function localMember(node: ts.PropertyAccessExpression | ts.ElementAccessExpression, seen = new Set<ts.Node>()): ts.Node | undefined {
    const key = ts.isPropertyAccessExpression(node) ? node.name.text
      : node.argumentExpression && (ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression))
        ? node.argumentExpression.text : undefined;
    const owner = localExpression(node.expression, seen);
    if (key === undefined || !owner || !ts.isObjectLiteralExpression(owner)) return undefined;
    for (let index = owner.properties.length - 1; index >= 0; index--) {
      const property = owner.properties[index];
      if (ts.isSpreadAssignment(property) || propertyKey(property.name) === undefined) return undefined;
      if (propertyKey(property.name) !== key) continue;
      if (ts.isPropertyAssignment(property)) return property.initializer;
      if (ts.isShorthandPropertyAssignment(property)) return property.name;
      if (ts.isMethodDeclaration(property)) return property;
      return undefined;
    }
    return undefined;
  }

  function isJsonData(node: ts.Node, seen = new Set<ts.Node>()): boolean {
    node = unwrap(node);
    if (seen.has(node) || seen.size >= 32) return false;
    const nextSeen = new Set(seen).add(node);
    if (ts.isIdentifier(node)) {
      const lexical = lexicalValue(node);
      const value = lexical ? lexical.value : locals.get(node.text);
      if (value) return isJsonData(value, nextSeen);
      return !lexical && /\.json$/i.test(imports.get(node.text)?.module || namespaces.get(node.text) || '');
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return isJsonData(node.expression, nextSeen);
    return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
      && !hasKnownBinding(node.expression) && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])
      && /\.json$/i.test(node.arguments[0].text);
  }

  function knownNonComponentMember(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean {
    if (isJsonData(node.expression)) return true;
    const owner = localExpression(node.expression);
    if (!owner) return false;
    if (ts.isArrayLiteralExpression(owner) || ts.isStringLiteralLike(owner) || ts.isNumericLiteral(owner)
      || [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(owner.kind)) return true;
    if (!ts.isObjectLiteralExpression(owner)) return false;
    const key = ts.isPropertyAccessExpression(node) ? node.name.text
      : node.argumentExpression && (ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression))
        ? node.argumentExpression.text : undefined;
    if (key === undefined) return false;
    // Only a closed literal with no matching property proves absence.
    // Accessors and dynamic spreads/keys remain unknown, never invoked.
    for (let index = owner.properties.length - 1; index >= 0; index--) {
      const property = owner.properties[index];
      if (ts.isSpreadAssignment(property) || propertyKey(property.name) === undefined || propertyKey(property.name) === key) return false;
    }
    return true;
  }

  async function namespaceMember(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): Promise<SourceValueExport | null | undefined> {
    const key = ts.isPropertyAccessExpression(node) ? node.name.text
      : node.argumentExpression && (ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression))
        ? node.argumentExpression.text : undefined;
    const owner = localExpression(node.expression);
    if (key === undefined || !owner || !ts.isIdentifier(owner) || lexicalValue(owner)) return undefined;
    const module = namespaces.get(owner.text);
    if (!module) return undefined;
    const resolved = await moduleExports(module, key);
    return resolved === null ? undefined : resolved.find(entry => entry.exportName === key) ?? null;
  }

  function selectsBinaryValue(node: ts.BinaryExpression): boolean {
    return [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]
      .includes(node.operatorToken.kind);
  }

  function arrayMapReceiver(node: ts.CallExpression): ts.Expression | undefined {
    const target = callTarget(node.expression);
    if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) return undefined;
    const key = ts.isPropertyAccessExpression(target) ? target.name.text
      : target.argumentExpression && ts.isStringLiteralLike(target.argumentExpression) ? target.argumentExpression.text : undefined;
    return key === 'map' || key === 'flatMap' ? target.expression : undefined;
  }

  function expressionType(node: ts.Node, seen = new Set<ts.Node>()): ts.TypeNode | undefined {
    node = unwrap(node);
    if (seen.has(node) || seen.size >= 32) return undefined;
    const nextSeen = new Set(seen).add(node);
    if (ts.isIdentifier(node)) {
      const lexical = lexicalValue(node);
      const type = lexical ? lexical.type : localTypes.get(node.text);
      if (type) return type;
      const value = lexical ? lexical.value : locals.get(node.text);
      return value ? expressionType(value, nextSeen) : undefined;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node) ? node.name.text
        : node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
      return key === undefined ? undefined : typeMember(expressionType(node.expression, nextSeen), key);
    }
    return undefined;
  }

  function arrayType(type: ts.TypeNode, seen = new Set<string>()): 'array' | 'other' | 'unknown' {
    if (ts.isParenthesizedTypeNode(type)) return arrayType(type.type, seen);
    if (ts.isArrayTypeNode(type) || ts.isTupleTypeNode(type)) return 'array';
    if (ts.isTypeOperatorNode(type)) return type.operator === ts.SyntaxKind.ReadonlyKeyword ? arrayType(type.type, seen) : 'other';
    if (ts.isUnionTypeNode(type)) {
      const kinds = new Set(type.types.map(member => arrayType(member, seen)));
      return kinds.size === 1 ? kinds.values().next().value! : 'unknown';
    }
    if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
      const name = type.typeName.text;
      if ((name === 'Array' || name === 'ReadonlyArray') && !typeAliases.has(name) && !interfaces.has(name)) return 'array';
      const alias = typeAliases.get(name);
      if (alias && !seen.has(name)) return arrayType(alias, new Set(seen).add(name));
      if (interfaces.has(name)) return 'unknown';
      return 'unknown';
    }
    if (ts.isTypeLiteralNode(type) || ts.isLiteralTypeNode(type) || ts.isFunctionTypeNode(type)
      || ts.isConstructorTypeNode(type) || [ts.SyntaxKind.StringKeyword, ts.SyntaxKind.NumberKeyword,
        ts.SyntaxKind.BooleanKeyword, ts.SyntaxKind.BigIntKeyword, ts.SyntaxKind.SymbolKeyword,
        ts.SyntaxKind.ObjectKeyword, ts.SyntaxKind.UndefinedKeyword, ts.SyntaxKind.VoidKeyword,
        ts.SyntaxKind.NeverKeyword].includes(type.kind)) return 'other';
    return 'unknown';
  }

  function arrayReceiverKind(node: ts.Node): 'array' | 'other' | 'unknown' {
    const type = expressionType(node);
    if (type) {
      const kind = arrayType(type);
      if (kind !== 'unknown') return kind;
    }
    const value = localExpression(node);
    if (!value) return 'unknown';
    if (ts.isArrayLiteralExpression(value)) return 'array';
    if (ts.isObjectLiteralExpression(value) || ts.isStringLiteralLike(value) || ts.isNumericLiteral(value)
      || [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(value.kind)) return 'other';
    return 'unknown';
  }

  function functionReturns(node: ts.FunctionLikeDeclaration): ts.Expression[] {
    if (!node.body) return [];
    if (!ts.isBlock(node.body)) return [node.body];
    const values: ts.Expression[] = [];
    const visit = (child: ts.Node): void => {
      if (ts.isReturnStatement(child)) { if (child.expression) values.push(child.expression); return; }
      if (ts.isFunctionLike(child) || ts.isClassLike(child)) return;
      ts.forEachChild(child, visit);
    };
    ts.forEachChild(node.body, visit);
    return values;
  }

  async function rendersFunction(node: ts.FunctionLikeDeclaration, name: string, seen: Set<ts.Node>): Promise<boolean> {
    if (/^use[A-Z]/.test(name)) return false;
    return someNode(functionReturns(node), value => renders(value, name, seen));
  }

  async function renders(node: ts.Node, name: string, seen = new Set<ts.Node>()): Promise<boolean> {
    node = unwrap(node);
    if (seen.has(node)) return false;
    const nextSeen = new Set(seen).add(node);
    if (isNodeFactory(node)) return false;
    if (ts.isIdentifier(node)) {
      const lexical = lexicalValue(node);
      if (lexical) return lexical.value ? renders(lexical.value, name, nextSeen) : isComponentName(name) || name === 'default';
      const local = locals.get(node.text);
      if (local) return renders(local, name, nextSeen);
      const imported = await importedValue(node.text);
      // An unknown imported constant's spelling is not evidence that a
      // lowercase helper renders. Keep the outer component-node context;
      // component-type aliases are handled separately below.
      return imported === undefined ? isComponentName(name) || name === 'default'
        : imported?.isNodeValue === true;
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const member = localMember(node);
      if (member) return renders(member, name, nextSeen);
      const imported = await namespaceMember(node);
      return imported === undefined ? isComponentName(name) || name === 'default' : imported?.isNodeValue === true;
    }
    if (ts.isAwaitExpression(node)) return renders(node.expression, name, nextSeen);
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return isComponentName(name) || name === 'default';
    if (ts.isConditionalExpression(node)) return await renders(node.whenTrue, name, nextSeen) || renders(node.whenFalse, name, nextSeen);
    if (ts.isBinaryExpression(node)) return node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ? renders(node.right, name, nextSeen) : await renders(node.left, name, nextSeen) || renders(node.right, name, nextSeen);
    if (ts.isArrayLiteralExpression(node)) return someNode(node.elements, element => renders(element, name, nextSeen));
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.NullKeyword) return isComponentName(name) || name === 'default';
    if (ts.isTaggedTemplateExpression(node)) return false;
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file);
      if (isNodeFactory(node.expression)) return true;
      if (callee === 'Promise.resolve' && !hasKnownBinding(node.expression))
        return Boolean(node.arguments[0]) && renders(node.arguments[0], name, nextSeen);
      if (/^styled(?:\.|\()/.test(callee) || /(?:^|\.)(?:memo|forwardRef|observer|lazy|connect)$/.test(callee)) return false;
      const target = localFunction(node.expression);
      // Within a helper, an unknown parameter/member must not gain node
      // evidence from the outer export's capitalized name. Actual JSX and
      // proven React factories still provide evidence through helper chains.
      if (target) return !nextSeen.has(target) && nextSeen.size < 64
        ? rendersFunction(target, '', new Set(nextSeen).add(target)) : false;
      const receiver = arrayMapReceiver(node);
      if (receiver && arrayReceiverKind(receiver) !== 'other') {
        const callback = node.arguments[0] && localFunction(node.arguments[0]);
        // Array callbacks produce the mapped values themselves. Preserve
        // ordinary unannotated props collections unless local facts disprove
        // the array contract; this is not generic callback-argument evidence.
        return callback ? rendersFunction(callback, name, nextSeen) : false;
      }
      return false;
    }
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
      // A function can be a component type or a callback, but its value is not
      // a rendered React node. Analyze its body only at a call/type boundary.
      return false;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      return false;
    }
    return false;
  }

  function isPrimitiveParameterType(type: ts.TypeNode, seen = new Set<string>()): boolean {
    if (ts.isParenthesizedTypeNode(type)) return isPrimitiveParameterType(type.type, seen);
    if (ts.isUnionTypeNode(type)) return type.types.every(member => isPrimitiveParameterType(member, seen));
    if (ts.isIntersectionTypeNode(type)) return type.types.some(member => isPrimitiveParameterType(member, seen));
    if (ts.isLiteralTypeNode(type) || ts.isTemplateLiteralTypeNode(type)) return true;
    if ([ts.SyntaxKind.StringKeyword, ts.SyntaxKind.NumberKeyword, ts.SyntaxKind.BooleanKeyword,
      ts.SyntaxKind.BigIntKeyword, ts.SyntaxKind.SymbolKeyword, ts.SyntaxKind.UndefinedKeyword,
      ts.SyntaxKind.VoidKeyword].includes(type.kind)) return true;
    if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
      const name = type.typeName.text;
      const alias = typeAliases.get(name);
      if (alias && !seen.has(name)) return isPrimitiveParameterType(alias, new Set(seen).add(name));
    }
    return false;
  }

  // ReactNode values can be returned by a component, but exporting a node
  // does not make it a component type. Keep this boundary separate from
  // return-value analysis so arrays/text/null inside components remain valid.
  async function isComponentType(node: ts.Node, name: string, seen = new Set<ts.Node>()): Promise<boolean> {
    node = unwrap(node);
    if (seen.has(node)) return false;
    const nextSeen = new Set(seen).add(node);
    if (isNodeFactory(node)) return false;
    if (isJsonData(node)) return false;
    if (ts.isIdentifier(node)) {
      const lexical = lexicalValue(node);
      if (lexical) return lexical.value ? isComponentType(lexical.value, name, nextSeen) : isComponentName(name) || name === 'default';
      const local = locals.get(node.text);
      if (local) return isComponentType(local, name, nextSeen);
      const imported = await importedValue(node.text);
      return imported === undefined ? imports.has(node.text) ? isComponentName(node.text) : isComponentName(name) || name === 'default'
        : imported?.isComponent === true;
    }
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
      const firstParameter = node.parameters[0];
      // A JSX formatter taking a string/number/etc. is a utility. React calls
      // components with a props object; unknown or object types remain valid.
      if (firstParameter?.type && isPrimitiveParameterType(firstParameter.type)) return false;
      // A typed scalar helper has no component contract merely because a
      // returned imported setting happens to be a valid React child. Named
      // text/number components retain their ordinary component convention.
      if (node.type && isPrimitiveParameterType(node.type) && !isComponentName(name) && name !== 'default') return false;
      return rendersFunction(node, name, nextSeen);
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return someNode(node.members, member =>
      ts.isMethodDeclaration(member) && member.name.getText(file) === 'render'
        ? rendersFunction(member, name, nextSeen) : Promise.resolve(false));
    if (ts.isTaggedTemplateExpression(node)) return /^styled(?:\.|\()/.test(node.tag.getText(file));
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file);
      if (isNodeFactory(node.expression)) return false;
      const target = localFunction(node.expression);
      if (target) {
        if (nextSeen.has(target) || nextSeen.size >= 64) return false;
        // The result of a known scalar-returning call cannot itself be a
        // component type, regardless of the exported constant's name.
        if (target.type && isPrimitiveParameterType(target.type)) return false;
        const callSeen = new Set(nextSeen).add(target);
        // A known local function's returned value takes precedence over HOC
        // compatibility. Passing Button to a data helper does not make the
        // helper's returned array/object/primitive a component type.
        return someNode(functionReturns(target), value => {
          const returned = unwrap(value);
          const parameter = ts.isIdentifier(returned) ? lexicalValue(returned)?.parameter : undefined;
          const index = parameter ? target.parameters.indexOf(parameter) : -1;
          if (index >= 0 && parameter && ts.isIdentifier(parameter.name)) {
            if (parameter.dotDotDotToken) return Promise.resolve(false);
            const argument = node.arguments[index] || parameter.initializer;
            return argument ? isComponentType(argument, name, callSeen) : Promise.resolve(false);
          }
          return isComponentType(value, name, callSeen);
        });
      }
      // Array mapping returns an array of values. Even a JSX-producing
      // callback cannot turn that returned array into a component type.
      if (arrayMapReceiver(node)) return false;
      if (/^styled(?:\.|\()/.test(callee)) return true;
      const wrapper = reactWrapper(node.expression);
      if (wrapper === 'lazy') return isComponentName(name) || name === 'default';
      if (wrapper === 'memo' || wrapper === 'forwardRef' || /(?:^|\.)(?:observer|connect)$/.test(callee))
        return someNode(node.arguments, argument => isComponentType(argument, name, nextSeen));
      return someNode(node.arguments, argument => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)
        || ts.isIdentifier(argument) ? isComponentType(argument, name, nextSeen) : Promise.resolve(false));
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const member = localMember(node);
      if (member) return isComponentType(member, name, nextSeen);
      if (knownNonComponentMember(node)) return false;
      const imported = await namespaceMember(node);
      return imported === undefined ? isComponentName(name) || name === 'default' : imported?.isComponent === true;
    }
    if (ts.isAwaitExpression(node)) return isComponentType(node.expression, name, nextSeen);
    if (ts.isConditionalExpression(node)) return await isComponentType(node.whenTrue, name, nextSeen) || isComponentType(node.whenFalse, name, nextSeen);
    if (ts.isBinaryExpression(node)) return node.operatorToken.kind === ts.SyntaxKind.EqualsToken || node.operatorToken.kind === ts.SyntaxKind.CommaToken
      ? isComponentType(node.right, name, nextSeen) : selectsBinaryValue(node)
        && (await isComponentType(node.left, name, nextSeen) || isComponentType(node.right, name, nextSeen));
    return false;
  }

  // Negative render evidence requires stable values. Reassigned bindings and
  // mutable initializers must not hide a component that can later produce UI.
  const writtenNames = new Set<string>();
  function recordWrites(node: ts.Node): void {
    function target(node: ts.Node): void {
      if (ts.isIdentifier(node)) writtenNames.add(node.text);
      else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) target(node.expression);
      else if (ts.isPropertyAssignment(node)) target(node.initializer);
      else ts.forEachChild(node, target);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) target(node.left);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) target(node.operand);
    ts.forEachChild(node, recordWrites);
  }
  recordWrites(file);
  function stableLocalValue(node: ts.Identifier): ts.Node | undefined {
    if (writtenNames.has(node.text)) return undefined;
    const lexical = lexicalValue(node);
    const value = lexical ? lexical.value : locals.get(node.text);
    if (!value) return undefined;
    if (ts.isFunctionDeclaration(value) || ts.isClassDeclaration(value)) return value;
    const declaration = value.parent;
    return ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 ? value : undefined;
  }
  function isChildren(node: ts.Node): boolean {
    function isProps(parameter: ts.ParameterDeclaration | undefined): parameter is ts.ParameterDeclaration {
      return Boolean(parameter && !parameter.initializer && ts.isFunctionLike(parameter.parent) && parameter.parent.parameters[0] === parameter);
    }
    if (ts.isIdentifier(node)) {
      if (writtenNames.has(node.text)) return false;
      const parameter = lexicalValue(node)?.parameter;
      if (!isProps(parameter) || !ts.isObjectBindingPattern(parameter.name)) return false;
      return parameter.name.elements.some(binding => ts.isIdentifier(binding.name) && binding.name.text === node.text
        && !binding.dotDotDotToken && !binding.initializer && propertyKey(binding.propertyName || binding.name) === 'children');
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node) ? node.name.text
        : node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
      const owner = unwrap(node.expression);
      if (key !== 'children' || !ts.isIdentifier(owner) || writtenNames.has(owner.text)) return false;
      const parameter = lexicalValue(owner)?.parameter;
      return isProps(parameter) && ts.isIdentifier(parameter.name);
    }
    return false;
  }
  const renderAnalysis = createSourceRenderRoleAnalyzer({
    localValue: stableLocalValue,
    localFunction: node => {
      node = callTarget(node);
      const target = ts.isIdentifier(node) ? stableLocalValue(node) : node;
      return target && (ts.isFunctionDeclaration(target) || ts.isFunctionExpression(target) || ts.isArrowFunction(target)) ? target : undefined;
    },
    importedValue: node => ts.isIdentifier(node)
      ? lexicalValue(node) || locals.has(node.text) ? Promise.resolve(undefined) : importedValue(node.text)
      : namespaceMember(node),
    isChildren, isUndefined: node => node.text === 'undefined' && !hasKnownBinding(node),
    reactReference, isNodeFactory, functionReturns,
  });

  const result: SourceValueExport[] = [];
  for (const binding of exports) {
    if (requestedExportName !== undefined && binding.name !== requestedExportName) continue;
    const localName = binding.local || (binding.value && 'name' in binding.value && binding.value.name && ts.isIdentifier(binding.value.name as ts.Node) ? (binding.value.name as ts.Identifier).text : binding.name);
    const imported = binding.imported || (binding.local ? imports.get(binding.local) : undefined);
    if (imported) {
      if (/\.json$/i.test(imported.module)) continue;
      const resolved = await moduleExports(imported.module, imported.name);
      const target = resolved?.find((entry) => entry.exportName === imported.name);
      if (target) result.push({ ...target, exportName: binding.name });
      // Package reexports remain candidates; Vite resolves the real value in
      // the workspace's installed package. Relative missing modules do not.
      else if (resolved === null && !imported.module.startsWith('.') && isComponentName(localName)) {
        result.push({ exportName: binding.name, localName, declarationId: `${imported.module}:${imported.name}`,
          bindingId: `${filePath}:import:${JSON.stringify([imported.module, imported.name])}`,
          isComponent: true, isNodeValue: false });
      }
      continue;
    }
    const value = binding.value || (binding.local ? locals.get(binding.local) : undefined);
    if (value) {
      const isComponent = await isComponentType(value, binding.name);
      const stable = !binding.local || !writtenNames.has(binding.local)
        && (ts.isFunctionDeclaration(value) || ts.isClassDeclaration(value)
          || ts.isVariableDeclaration(value.parent) && ts.isVariableDeclarationList(value.parent.parent)
            && (value.parent.parent.flags & ts.NodeFlags.Const) !== 0);
      const renderRole = isComponent && stable ? await renderAnalysis.componentRole(value) : undefined;
      result.push({
        exportName: binding.name, localName, declarationId: `${filePath}:${binding.local || value.pos}`,
        isComponent,
        isNodeValue: await renders(value, 'default'),
        ...(renderRole ? { renderRole } : {}),
        ...(!isComponent && stable && await renderAnalysis.isContext(value) ? { isContext: true } : {}),
      });
    }
  }
  const explicitNames = new Set(exports.map(binding => binding.name));
  const starExports = new Map<string, SourceValueExport | null>();
  const starModules = requestedExportName !== undefined && explicitNames.has(requestedExportName) ? [] : stars;
  for (const specifier of starModules) {
    for (const entry of await moduleExports(specifier, requestedExportName) || []) {
      if (entry.exportName === 'default' || explicitNames.has(entry.exportName)) continue;
      if (!starExports.has(entry.exportName)) starExports.set(entry.exportName, entry);
      else {
        const previous = starExports.get(entry.exportName);
        if (!previous || sourceExportIdentity(previous) !== sourceExportIdentity(entry)) starExports.set(entry.exportName, null);
      }
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
  return entries.filter(entry => entry.isComponent).map(({ isComponent, isNodeValue, isContext, ...entry }) => entry);
}

export function orderSourceComponentExports(entries: SourceComponentExport[], fileName: string): SourceComponentExport[] {
  const score = (entry: SourceComponentExport) => entry.exportName === 'default' ? 0 : entry.exportName.toLowerCase() === fileName.toLowerCase() ? 1 : 2;
  const seen = new Set<string>();
  return [...entries].sort((a, b) => score(a) - score(b)).filter((entry) => {
    const identity = sourceExportIdentity(entry);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
