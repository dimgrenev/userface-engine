import ts from 'typescript';

type RenderRole = 'nonvisual' | 'provider';
type Output = 'empty' | 'children' | 'provider' | 'unknown';
type ImportedEvidence = { renderRole?: RenderRole; isContext?: boolean };
type Host = {
  localValue(node: ts.Identifier): ts.Node | undefined;
  localFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined;
  importedValue(node: ts.Identifier | ts.PropertyAccessExpression | ts.ElementAccessExpression): Promise<ImportedEvidence | null | undefined>;
  isChildren(node: ts.Node): boolean;
  isUndefined(node: ts.Identifier): boolean;
  reactReference(node: ts.Node): { module: string; name: string | null } | null;
  isNodeFactory(node: ts.Node): boolean;
  functionReturns(node: ts.FunctionLikeDeclaration): ts.Expression[];
};

/** Negative evidence only. Unknown values never hide a component. The host
 * supplies the discovery owner's bindings, React provenance and import graph. */
export function createSourceRenderRoleAnalyzer(host: Host) {
  function unwrap(node: ts.Node): ts.Node {
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
      || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) node = node.expression;
    return node;
  }
  function memberKey(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
    return ts.isPropertyAccessExpression(node) ? node.name.text
      : node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
  }
  function propertyKey(node: ts.PropertyName | undefined): string | undefined {
    if (!node) return undefined;
    if (ts.isComputedPropertyName(node)) return ts.isStringLiteralLike(node.expression) ? node.expression.text : undefined;
    return ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) ? node.text : undefined;
  }
  function next(node: ts.Node, seen: Set<ts.Node>): Set<ts.Node> | undefined {
    return seen.has(node) || seen.size >= 64 ? undefined : new Set(seen).add(node);
  }
  function combine(values: Output[]): Output {
    if (values.includes('unknown')) return 'unknown';
    if (values.includes('provider')) return 'provider';
    return values.includes('children') ? 'children' : 'empty';
  }
  async function isContext(node: ts.Node, seen = new Set<ts.Node>()): Promise<boolean> {
    node = unwrap(node);
    const following = next(node, seen);
    if (!following) return false;
    if (ts.isCallExpression(node)) {
      const reference = host.reactReference(node.expression);
      return reference?.module === 'react' && reference.name === 'createContext';
    }
    if (ts.isIdentifier(node)) {
      const local = host.localValue(node);
      return local ? isContext(local, following) : (await host.importedValue(node))?.isContext === true;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      return (await host.importedValue(node))?.isContext === true;
    }
    return false;
  }
  async function isProvider(node: ts.Node): Promise<boolean> {
    return (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && memberKey(node) === 'Provider'
      ? isContext(node.expression) : isContext(node); // React 19 context shorthand.
  }
  async function children(nodes: readonly ts.Node[], seen: Set<ts.Node>): Promise<Output> {
    return combine(await Promise.all(nodes.map(node => ts.isJsxText(node)
      ? Promise.resolve<Output>(node.text.trim() ? 'unknown' : 'empty') : output(node, seen))));
  }
  async function output(node: ts.Node, seen: Set<ts.Node>): Promise<Output> {
    node = unwrap(node);
    const following = next(node, seen);
    if (!following) return 'unknown';
    if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.TrueKeyword
      || node.kind === ts.SyntaxKind.FalseKeyword || ts.isVoidExpression(node)) return 'empty';
    if (host.isChildren(node)) return 'children';
    if (ts.isIdentifier(node)) {
      const local = host.localValue(node);
      if (local) return output(local, following);
      return host.isUndefined(node) ? 'empty' : 'unknown';
    }
    if (ts.isJsxExpression(node)) return node.expression ? output(node.expression, following) : 'empty';
    if (ts.isJsxFragment(node)) return children(node.children, following);
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      if (!await isProvider(opening.tagName)) return 'unknown';
      // Spread props or an explicit children prop can supply independent UI.
      if (opening.attributes.properties.some(prop => ts.isJsxSpreadAttribute(prop)
        || ts.isIdentifier(prop.name) && prop.name.text === 'children')) return 'unknown';
      const nested = ts.isJsxElement(node) ? await children(node.children, following) : 'empty';
      return nested === 'unknown' ? 'unknown' : 'provider';
    }
    if (ts.isConditionalExpression(node)) return combine(await Promise.all([
      output(node.whenTrue, following), output(node.whenFalse, following),
    ]));
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken || node.operatorToken.kind === ts.SyntaxKind.CommaToken)
        return output(node.right, following);
      if ([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind))
        return combine(await Promise.all([output(node.left, following), output(node.right, following)]));
    }
    if (ts.isArrayLiteralExpression(node)) return combine(await Promise.all(node.elements.map(value => output(value, following))));
    if (ts.isAwaitExpression(node)) return output(node.expression, following);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      // A local object's properties can be mutated, even when its binding is
      // const. Do not infer an always-empty render from its initializer.
      return 'unknown';
    }
    if (ts.isCallExpression(node) && host.isNodeFactory(node.expression) && node.arguments[0]) {
      if (!await isProvider(node.arguments[0])) return 'unknown';
      const reference = host.reactReference(node.expression);
      const props = node.arguments[1] && unwrap(node.arguments[1]);
      if (reference?.module === 'react/jsx-runtime' || reference?.module === 'react/jsx-dev-runtime') {
        if (!props || !ts.isObjectLiteralExpression(props)) return 'unknown';
        const values: Output[] = [];
        for (const property of props.properties) {
          if (ts.isSpreadAssignment(property)) return 'unknown';
          const key = propertyKey(property.name);
          if (key === undefined || key === '__proto__') return 'unknown';
          if (key === 'children') {
            if (!ts.isPropertyAssignment(property)) return 'unknown';
            values.push(await output(property.initializer, following));
          }
        }
        return combine(values) === 'unknown' ? 'unknown' : 'provider';
      }
      // createElement props may contain children unless the literal proves otherwise.
      if (props && props.kind !== ts.SyntaxKind.NullKeyword && (!ts.isObjectLiteralExpression(props)
        || props.properties.some(property => ts.isSpreadAssignment(property)
          || propertyKey(property.name) === undefined || propertyKey(property.name) === '__proto__'
          || propertyKey(property.name) === 'children'))) return 'unknown';
      return await children(node.arguments.slice(2), following) === 'unknown' ? 'unknown' : 'provider';
    }
    if (ts.isCallExpression(node)) {
      const target = host.localFunction(node.expression);
      if (!target?.body || following.has(target)) return 'unknown';
      const result = combine(await Promise.all(host.functionReturns(target).map(value => output(value, new Set(following).add(target)))));
      // A helper's children may be explicit visual call arguments. Without
      // argument substitution only an empty result is negative evidence.
      return result === 'empty' ? 'empty' : 'unknown';
    }
    return 'unknown';
  }
  async function componentRole(node: ts.Node, seen = new Set<ts.Node>()): Promise<RenderRole | undefined> {
    node = unwrap(node);
    const following = next(node, seen);
    if (!following) return undefined;
    if (ts.isIdentifier(node)) {
      const local = host.localValue(node);
      return local ? componentRole(local, following) : (await host.importedValue(node))?.renderRole;
    }
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
      // A declaration without a body is unknown; a body with no return has no surface.
      if (!node.body) return undefined;
      const result = combine(await Promise.all(host.functionReturns(node).map(value => output(value, following))));
      return result === 'empty' ? 'nonvisual' : result === 'provider' ? 'provider' : undefined;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const base = node.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
      const reference = base && host.reactReference(base);
      // A custom base, constructor or additional field/method can replace
      // render. Only the closed React render-only class supplies this proof.
      if (reference?.module !== 'react' || !['Component', 'PureComponent'].includes(reference.name || '')
        || node.members.some(member => !ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name) || member.name.text !== 'render')) return undefined;
      const render = node.members.find(member => ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === 'render');
      return render ? componentRole(render, following) : undefined;
    }
    if (ts.isCallExpression(node)) {
      const reference = host.reactReference(node.expression);
      // Unknown HOCs can add UI; their arguments are not negative evidence.
      return reference?.module === 'react' && (reference.name === 'memo' || reference.name === 'forwardRef') && node.arguments[0]
        ? componentRole(node.arguments[0], following) : undefined;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      return (await host.importedValue(node))?.renderRole;
    return undefined;
  }
  return { componentRole, isContext };
}
