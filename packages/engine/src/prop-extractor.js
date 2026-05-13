/**
 * PropExtractor - Browser-side prop extraction with Babel AST (primary) and regex (fallback).
 *
 * Public API (unchanged):
 *   PropExtractor.extract(code, framework) -> [{ name, type, required, defaultValue?, options?, description }]
 *
 * When `window.Babel` (from @babel/standalone) is available, parses the source into an AST
 * for accurate extraction of props from TypeScript interfaces, type aliases, destructured
 * function params, forwardRef / memo wrappers, intersection types, etc.
 * Falls back to regex-based extraction when Babel is not loaded or parsing fails.
 */

class PropExtractor {

  // ═══════════════════════════════════════════════════════════════════════
  // AST-based extraction (primary path when Babel is available)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Safely parse code into a Babel AST.
   * Returns null if Babel is unavailable or parsing fails.
   */
  static _parseAST(code) {
    try {
      const B = (typeof Babel !== 'undefined') ? Babel : (typeof window !== 'undefined' ? window.Babel : null);
      if (!B) return null;

      // @babel/standalone exposes the parser at Babel.packages.parser.parse,
      // NOT as Babel.parse (which doesn't exist).
      const parser = B.packages && B.packages.parser;
      if (!parser || typeof parser.parse !== 'function') return null;

      return parser.parse(code, {
        sourceType: 'module',
        plugins: ['typescript', 'jsx'],
        errorRecovery: true
      });
    } catch (e) {
      return null;
    }
  }

  /**
   * Extract string literal values from a TSUnionType AST node.
   * Returns ['a','b'] for `'a' | 'b'`, null if non-literal members exist.
   * Skips `undefined` and `null` members in the union.
   */
  static _extractStringLiteralsFromUnionNode(typeNode) {
    if (!typeNode || typeNode.type !== 'TSUnionType') return null;
    const literals = [];
    for (const member of typeNode.types) {
      if (member.type === 'TSLiteralType' && member.literal && member.literal.type === 'StringLiteral') {
        literals.push(member.literal.value);
      } else if (member.type === 'TSUndefinedKeyword' || member.type === 'TSNullKeyword') {
        // skip — still a valid string-literal union
      } else if (member.type === 'TSBooleanKeyword' ||
                 (member.type === 'TSLiteralType' && member.literal && member.literal.type === 'BooleanLiteral') ||
                 member.type === 'TSNumberKeyword' ||
                 (member.type === 'TSLiteralType' && member.literal && member.literal.type === 'NumericLiteral')) {
        // skip — union like 'sm' | 'md' | boolean still has valid string options
      } else {
        return null;
      }
    }
    return literals.length > 0 ? literals : null;
  }

  /**
   * Build a dotted name from a TSQualifiedName (e.g. React.ReactNode).
   */
  static _qualifiedName(node) {
    if (!node) return '';
    if (node.type === 'Identifier') return node.name;
    if (node.type === 'TSQualifiedName') {
      return this._qualifiedName(node.left) + '.' + (node.right ? node.right.name : '');
    }
    return '';
  }

  /**
   * Resolve a TS type-annotation AST node -> { type: string, options?: string[] }.
   * `aliases` is a map of local type-alias names -> string-literal arrays.
   */
  static _resolveTypeAnnotation(typeNode, aliases) {
    if (!typeNode) return { type: 'any' };

    switch (typeNode.type) {
      case 'TSStringKeyword':    return { type: 'string' };
      case 'TSNumberKeyword':    return { type: 'number' };
      case 'TSBooleanKeyword':   return { type: 'boolean' };
      case 'TSAnyKeyword':       return { type: 'any' };
      case 'TSVoidKeyword':      return { type: 'any' };
      case 'TSNeverKeyword':     return { type: 'any' };
      case 'TSUndefinedKeyword': return { type: 'any' };
      case 'TSNullKeyword':      return { type: 'any' };
      case 'TSObjectKeyword':    return { type: 'object' };
      case 'TSTypeLiteral':      return { type: 'object' };
      case 'TSArrayType':        return { type: 'array' };
      case 'TSTupleType':        return { type: 'array' };
      case 'TSFunctionType':     return { type: 'any' };
      case 'TSIntersectionType': return { type: 'object' };

      case 'TSUnionType': {
        const literals = this._extractStringLiteralsFromUnionNode(typeNode);
        if (literals) return { type: 'select', options: literals };
        // Union with non-literal members: resolve first meaningful member
        const nonNull = typeNode.types.filter(t =>
          t.type !== 'TSUndefinedKeyword' && t.type !== 'TSNullKeyword'
        );
        if (nonNull.length === 1) return this._resolveTypeAnnotation(nonNull[0], aliases);
        return { type: 'any' };
      }

      case 'TSTypeReference': {
        const typeName = typeNode.typeName;
        let name = '';
        if (typeName) {
          name = typeName.type === 'Identifier' ? typeName.name : this._qualifiedName(typeName);
        }
        // Check local type aliases first
        if (aliases && aliases[name]) return { type: 'select', options: aliases[name] };
        // Known React types
        if (name === 'ReactNode' || name === 'React.ReactNode') return { type: 'node' };
        if (name === 'JSX.Element' || name === 'ReactElement' || name === 'React.ReactElement') return { type: 'node' };
        if (name === 'CSSProperties' || name === 'React.CSSProperties') return { type: 'object' };
        if (name === 'Record' || name === 'Partial' || name === 'Omit' || name === 'Pick') return { type: 'object' };
        if (name === 'Array' || name === 'ReadonlyArray') return { type: 'array' };
        // Preserve PascalCase type references for downstream consumers (PropsEditor)
        if (/^[A-Z]/.test(name)) return { type: name };
        return { type: 'any' };
      }

      case 'TSParenthesizedType':
        return this._resolveTypeAnnotation(typeNode.typeAnnotation, aliases);

      case 'TSTypeOperator':
        // keyof T → always produces a string (union of key names)
        if (typeNode.operator === 'keyof') return { type: 'string' };
        // readonly T → unwrap
        return this._resolveTypeAnnotation(typeNode.typeAnnotation, aliases);

      case 'TSConditionalType':
        // Best-effort: resolve the true branch
        return this._resolveTypeAnnotation(typeNode.trueType, aliases);

      case 'TSMappedType':
        return { type: 'object' };

      case 'TSTemplateLiteralType':
        return { type: 'string' };

      case 'TSIndexedAccessType':
        return { type: 'any' };

      default:
        return { type: 'any' };
    }
  }

  /**
   * Recursively collect all TSTypeLiteral nodes from a type.
   * Handles intersection types: `A & { x: number } & B`.
   */
  static _collectTypeLiterals(typeNode) {
    if (!typeNode) return [];
    if (typeNode.type === 'TSTypeLiteral') return [typeNode];
    if (typeNode.type === 'TSIntersectionType') {
      const result = [];
      for (const t of typeNode.types) {
        result.push(...this._collectTypeLiterals(t));
      }
      return result;
    }
    if (typeNode.type === 'TSParenthesizedType') {
      return this._collectTypeLiterals(typeNode.typeAnnotation);
    }
    return [];
  }

  /**
   * Convert an AST expression node to a default-value string
   * compatible with inferType() / cleanDefaultValue().
   */
  static _nodeToDefaultValue(node) {
    if (!node) return undefined;
    switch (node.type) {
      case 'StringLiteral':  return "'" + node.value + "'";
      case 'NumericLiteral': return String(node.value);
      case 'BooleanLiteral': return String(node.value);
      case 'NullLiteral':    return 'null';
      case 'Identifier':
        if (node.name === 'undefined') return undefined;
        return node.name;
      case 'UnaryExpression':
        if (node.operator === '-' && node.argument && node.argument.type === 'NumericLiteral') {
          return '-' + String(node.argument.value);
        }
        return undefined;
      case 'ArrayExpression':  return '[]';
      case 'ObjectExpression': return '{}';
      case 'TemplateLiteral':  return "''";
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
        return '() => {}';
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
        // Unwrap `value as const` / `value satisfies Type` to get the actual default
        return PropExtractor._nodeToDefaultValue(node.expression);
      // Dynamic/computed defaults: not statically known, but a default EXISTS → prop is not required
      case 'CallExpression':
      case 'MemberExpression':
      case 'ConditionalExpression':
      case 'NewExpression':
      case 'TaggedTemplateExpression':
      case 'LogicalExpression':
      case 'BinaryExpression':
        return '<computed>';
      default: return undefined;
    }
  }

  /**
   * Extract local type aliases that resolve to string-literal unions.
   * e.g. `type Variant = 'a' | 'b'` -> { Variant: ['a', 'b'] }
   */
  static _extractLocalAliasesAST(ast) {
    // First pass: collect ALL non-Props type aliases and their raw type annotations.
    const rawAliases = {};
    for (const node of ast.program.body) {
      let decl = node;
      if (node.type === 'ExportNamedDeclaration' && node.declaration) {
        decl = node.declaration;
      }
      if (decl.type !== 'TSTypeAliasDeclaration') continue;
      const name = decl.id && decl.id.name;
      if (!name) continue;
      // Don't skip Props-suffixed names — they might be string union aliases
      rawAliases[name] = decl.typeAnnotation;
    }

    // Second pass: resolve aliases with transitive references.
    // e.g. `type A = B; type B = 'x' | 'y'` → A resolves to ['x', 'y']
    const aliases = {};
    const resolve = (name, visited) => {
      if (aliases[name]) return aliases[name];
      if (visited.has(name)) return null; // cycle guard
      visited.add(name);
      const typeNode = rawAliases[name];
      if (!typeNode) return null;
      // Direct union of string literals
      const literals = this._extractStringLiteralsFromUnionNode(typeNode);
      if (literals) { aliases[name] = literals; return literals; }
      // TSTypeReference → follow chain
      if (typeNode.type === 'TSTypeReference' && typeNode.typeName &&
          typeNode.typeName.type === 'Identifier' && rawAliases[typeNode.typeName.name]) {
        const resolved = resolve(typeNode.typeName.name, visited);
        if (resolved) { aliases[name] = resolved; return resolved; }
      }
      return null;
    };

    for (const name of Object.keys(rawAliases)) {
      resolve(name, new Set());
    }
    return aliases;
  }

  /**
   * Extract props from TypeScript interface declarations: `interface XProps { ... }`.
   */
  static _extractFromInterfacesAST(ast, aliases) {
    // Build a map of ALL interfaces in the file for `extends` resolution.
    const interfaceMap = {};
    for (const node of ast.program.body) {
      let decl = node;
      if (node.type === 'ExportNamedDeclaration' && node.declaration) decl = node.declaration;
      if (decl.type === 'TSInterfaceDeclaration' && decl.id && decl.id.name) {
        interfaceMap[decl.id.name] = decl;
      }
    }

    const extractMembers = (decl, visited) => {
      if (!decl || !decl.body) return [];
      const name = decl.id && decl.id.name;
      if (name && visited.has(name)) return []; // cycle guard
      if (name) visited.add(name);
      const result = [];

      // Collect from parent interfaces (`extends BaseProps, OtherProps`)
      if (Array.isArray(decl.extends)) {
        for (const ext of decl.extends) {
          const parentName = (ext.expression && ext.expression.type === 'Identifier')
            ? ext.expression.name : null;
          // Skip React/HTML built-in types — we can't resolve them and they add noise
          if (parentName && interfaceMap[parentName] && !/^(React\.|HTML|SVG|Aria)/i.test(parentName)) {
            result.push(...extractMembers(interfaceMap[parentName], visited));
          }
        }
      }

      // Collect direct members
      const members = (decl.body && decl.body.body) ? decl.body.body : [];
      for (const member of members) {
        if (member.type !== 'TSPropertySignature') continue;
        // PX-AST-007: Handle both Identifier and StringLiteral keys (e.g. 'aria-label').
        const propName = (member.key && member.key.type === 'Identifier') ? member.key.name
          : (member.key && member.key.type === 'StringLiteral') ? member.key.value : null;
        if (!propName) continue;
        const optional = !!member.optional;
        const typeAnn = (member.typeAnnotation && member.typeAnnotation.typeAnnotation)
          ? member.typeAnnotation.typeAnnotation : null;
        const resolved = this._resolveTypeAnnotation(typeAnn, aliases);
        const prop = {
          name: propName,
          type: resolved.type,
          required: !optional,
          description: `${propName} prop`
        };
        if (resolved.options) prop.options = resolved.options;
        result.push(prop);
      }
      return result;
    };

    const props = [];
    for (const iName of Object.keys(interfaceMap)) {
      if (!iName.includes('Props')) continue;
      const extracted = extractMembers(interfaceMap[iName], new Set());
      // Deduplicate: child interface's own members win over parent's
      const seen = new Set();
      for (let i = extracted.length - 1; i >= 0; i--) {
        if (seen.has(extracted[i].name)) { extracted.splice(i, 1); continue; }
        seen.add(extracted[i].name);
      }
      props.push(...extracted);
    }
    return props;
  }

  /**
   * Extract props from TypeScript type alias declarations:
   * `type XProps = { ... }` and intersection types `A & B & { ... }`.
   */
  static _extractFromTypeAliasesAST(ast, aliases) {
    // Build interface + type alias maps for reference resolution in intersection types
    const interfaceMap = {};
    const typeAliasMap = {};
    for (const node of ast.program.body) {
      let d = node;
      if (node.type === 'ExportNamedDeclaration' && node.declaration) d = node.declaration;
      if (d.type === 'TSInterfaceDeclaration' && d.id) interfaceMap[d.id.name] = d;
      if (d.type === 'TSTypeAliasDeclaration' && d.id) typeAliasMap[d.id.name] = d;
    }

    const self = this;

    // Extract members from a TSTypeLiteral or resolved type reference
    const extractMembersFromLiteral = (literal) => {
      const result = [];
      const members = literal.members || [];
      for (const member of members) {
        if (member.type !== 'TSPropertySignature') continue;
        // PX-AST-007: Handle both Identifier and StringLiteral keys.
        const propName = (member.key && member.key.type === 'Identifier') ? member.key.name
          : (member.key && member.key.type === 'StringLiteral') ? member.key.value : null;
        if (!propName) continue;
        const optional = !!member.optional;
        const typeAnn = (member.typeAnnotation && member.typeAnnotation.typeAnnotation)
          ? member.typeAnnotation.typeAnnotation : null;
        const resolved = self._resolveTypeAnnotation(typeAnn, aliases);
        const prop = { name: propName, type: resolved.type, required: !optional, description: `${propName} prop` };
        if (resolved.options) prop.options = resolved.options;
        result.push(prop);
      }
      return result;
    };

    // Resolve a type reference to its members (follows interfaces and type aliases)
    const resolveRef = (refName, visited) => {
      if (!refName || visited.has(refName)) return [];
      visited.add(refName);
      // Check interface map
      if (interfaceMap[refName] && interfaceMap[refName].body && interfaceMap[refName].body.body) {
        const result = [];
        // Handle extends
        if (Array.isArray(interfaceMap[refName].extends)) {
          for (const ext of interfaceMap[refName].extends) {
            const pName = (ext.expression && ext.expression.type === 'Identifier') ? ext.expression.name : null;
            if (pName) result.push(...resolveRef(pName, visited));
          }
        }
        for (const member of interfaceMap[refName].body.body) {
          if (member.type !== 'TSPropertySignature') continue;
          // PX-AST-007: Handle both Identifier and StringLiteral keys.
          const propName = (member.key && member.key.type === 'Identifier') ? member.key.name
            : (member.key && member.key.type === 'StringLiteral') ? member.key.value : null;
          if (!propName) continue;
          const optional = !!member.optional;
          const typeAnn = (member.typeAnnotation && member.typeAnnotation.typeAnnotation)
            ? member.typeAnnotation.typeAnnotation : null;
          const resolved = self._resolveTypeAnnotation(typeAnn, aliases);
          const prop = { name: propName, type: resolved.type, required: !optional, description: `${propName} prop` };
          if (resolved.options) prop.options = resolved.options;
          result.push(prop);
        }
        return result;
      }
      // Check type alias map
      if (typeAliasMap[refName] && typeAliasMap[refName].typeAnnotation) {
        return extractFromTypeNode(typeAliasMap[refName].typeAnnotation, visited);
      }
      return [];
    };

    // Extract props from any type node (literal, intersection, reference)
    const extractFromTypeNode = (typeNode, visited) => {
      if (!typeNode) return [];
      if (typeNode.type === 'TSTypeLiteral') return extractMembersFromLiteral(typeNode);
      if (typeNode.type === 'TSIntersectionType') {
        const result = [];
        for (const t of typeNode.types) {
          result.push(...extractFromTypeNode(t, visited));
        }
        return result;
      }
      if (typeNode.type === 'TSTypeReference' && typeNode.typeName && typeNode.typeName.type === 'Identifier') {
        return resolveRef(typeNode.typeName.name, visited);
      }
      if (typeNode.type === 'TSParenthesizedType') {
        return extractFromTypeNode(typeNode.typeAnnotation, visited);
      }
      return [];
    };

    const props = [];
    for (const node of ast.program.body) {
      let decl = node;
      if (node.type === 'ExportNamedDeclaration' && node.declaration) {
        decl = node.declaration;
      }
      if (decl.type !== 'TSTypeAliasDeclaration') continue;
      if (!decl.id || !decl.id.name || !decl.id.name.includes('Props')) continue;

      const extracted = extractFromTypeNode(decl.typeAnnotation, new Set());
      // Deduplicate: later entries (own props) win over earlier (base props)
      const seen = new Set();
      for (let i = extracted.length - 1; i >= 0; i--) {
        if (seen.has(extracted[i].name)) { extracted.splice(i, 1); continue; }
        seen.add(extracted[i].name);
      }
      props.push(...extracted);
    }
    return props;
  }

  /**
   * Recurse into CallExpression wrappers (forwardRef, memo, observer, styled)
   * to find the inner component function and extract its destructured params.
   */
  static _processCallExprForProps(callNode, extractFromParams) {
    if (!callNode || callNode.type !== 'CallExpression') return;
    const callee = callNode.callee;
    let calleeName = '';
    if (callee && callee.type === 'Identifier') {
      calleeName = callee.name;
    } else if (callee && callee.type === 'MemberExpression' &&
               callee.property && callee.property.type === 'Identifier') {
      calleeName = callee.property.name;
    }

    const wrappers = ['forwardRef', 'memo', 'observer', 'styled', 'lazy'];
    if (!wrappers.includes(calleeName) || !callNode.arguments || callNode.arguments.length === 0) return;

    const arg = callNode.arguments[0];
    if (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression') {
      extractFromParams(arg.params);
    } else if (arg.type === 'CallExpression') {
      // Nested: memo(forwardRef(...))
      this._processCallExprForProps(arg, extractFromParams);
    }
  }

  /**
   * Extract props from function parameter destructuring.
   * Handles function declarations, arrow functions, forwardRef, memo, exports.
   */
  static _extractFromDestructuringAST(ast) {
    const props = [];
    const seen = new Set();
    const self = this;

    const extractFromParams = (params) => {
      if (!params || params.length === 0) return;
      const first = params[0];
      if (first.type !== 'ObjectPattern') return;

      for (const prop of (first.properties || [])) {
        if (prop.type === 'RestElement') continue;
        if (prop.type !== 'ObjectProperty') continue;

        const name = (prop.key && prop.key.type === 'Identifier') ? prop.key.name : null;
        if (!name || name === 'key' || name === 'ref') continue;
        if (seen.has(name)) continue;
        seen.add(name);

        let defaultValue;
        const valueNode = prop.value;
        if (valueNode && valueNode.type === 'AssignmentPattern') {
          defaultValue = self._nodeToDefaultValue(valueNode.right);
        }

        const hasDefault = defaultValue !== undefined;
        const isComputed = defaultValue === '<computed>';
        const p = {
          name,
          type: isComputed ? 'any' : self.inferType(defaultValue),
          required: !hasDefault,
          description: `${name} prop`
        };
        if (hasDefault && !isComputed) {
          p.defaultValue = self.cleanDefaultValue(defaultValue);
        }
        props.push(p);
      }
    };

    const processNode = (node) => {
      if (!node) return;
      if (node.type === 'FunctionDeclaration' ||
          node.type === 'FunctionExpression' ||
          node.type === 'ArrowFunctionExpression') {
        extractFromParams(node.params);
      } else if (node.type === 'CallExpression') {
        self._processCallExprForProps(node, extractFromParams);
      }
    };

    for (const stmt of ast.program.body) {
      // export default function X({...}) | export default (() => ...)
      if (stmt.type === 'ExportDefaultDeclaration') {
        processNode(stmt.declaration);
        continue;
      }

      // export function X({...}) | export const X = ...
      if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) {
        const d = stmt.declaration;
        if (d.type === 'FunctionDeclaration') {
          processNode(d);
        } else if (d.type === 'VariableDeclaration') {
          for (const decl of d.declarations) {
            if (decl.init) processNode(decl.init);
          }
        }
        continue;
      }

      // function X({...})
      if (stmt.type === 'FunctionDeclaration') {
        processNode(stmt);
        continue;
      }

      // const X = ({...}) => ... | const X = forwardRef(...)
      if (stmt.type === 'VariableDeclaration') {
        for (const decl of stmt.declarations) {
          if (decl.init) processNode(decl.init);
        }
        continue;
      }

      // module.exports = function({...})
      if (stmt.type === 'ExpressionStatement' &&
          stmt.expression && stmt.expression.type === 'AssignmentExpression') {
        processNode(stmt.expression.right);
      }
    }

    return props;
  }

  /**
   * Main AST extraction: extracts from all sources and merges.
   */
  static _extractWithAST(ast) {
    const aliases = this._extractLocalAliasesAST(ast);
    const destructuredProps = this._extractFromDestructuringAST(ast);
    const interfaceProps = this._extractFromInterfacesAST(ast, aliases);
    const typeAliasProps = this._extractFromTypeAliasesAST(ast, aliases);

    const all = [...destructuredProps, ...interfaceProps, ...typeAliasProps];
    return this._mergeProps(all);
  }


  // ═══════════════════════════════════════════════════════════════════════
  // Regex-based extraction (fallback when Babel is unavailable)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Extract a balanced { ... } block starting at braceStart.
   */
  static extractBraceBlock(code, braceStart) {
    if (braceStart < 0) return null;
    let depth = 0;
    let start = -1;
    for (let i = braceStart; i < code.length; i++) {
      const ch = code[i];
      if (ch === '{') {
        depth++;
        if (depth === 1) start = i + 1;
      } else if (ch === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          return { body: code.slice(start, i), end: i + 1 };
        }
      }
    }
    return null;
  }

  /**
   * Split interface/type body into prop-like lines, respecting nested braces.
   */
  static splitInterfaceBody(body) {
    const parts = [];
    let current = '';
    let depth = 0;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      if (depth === 0 && (ch === ';' || ch === '\n')) {
        if (current.trim()) parts.push(current.trim());
        current = '';
        continue;
      }
      current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  /**
   * Regex: extract props from destructured function parameters.
   */
  static extractFromFunctionDestructuring(code) {
    const props = [];

    const patterns = [
      /function\s+\w+\s*\(\s*\{([^}]+)\}\s*(?::\s*\w+)?\s*\)/g,
      /const\s+\w+\s*=\s*\(\s*\{([^}]+)\}\s*(?::\s*\w+)?\s*\)\s*=>/g,
      /\(\s*\{([^}]+)\}\s*(?::\s*\w+)?\s*\)\s*=>/g,
      /export\s+default\s+function\s+\w+\s*\(\s*\{([^}]+)\}\s*(?::\s*\w+)?\s*\)/g
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(code)) !== null) {
        const propsString = match[1];
        const extractedProps = this.parsePropsString(propsString);
        props.push(...extractedProps);
      }
    }

    return props;
  }

  /**
   * Regex: parse a comma-separated string of destructured props.
   */
  static parsePropsString(propsString) {
    const props = [];
    const propParts = this.splitPropsString(propsString);
    for (const part of propParts) {
      const prop = this.parseSingleProp(part.trim());
      if (prop) props.push(prop);
    }
    return props;
  }

  /**
   * Regex: split props string by commas, respecting nested braces.
   */
  static splitPropsString(propsString) {
    const parts = [];
    let current = '';
    let braceCount = 0;

    for (let i = 0; i < propsString.length; i++) {
      const char = propsString[i];
      if (char === '{') braceCount++;
      else if (char === '}') braceCount--;
      else if (char === ',' && braceCount === 0) {
        parts.push(current.trim());
        current = '';
        continue;
      }
      current += char;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  /**
   * Regex: parse a single prop entry from destructuring.
   */
  static parseSingleProp(propString) {
    propString = propString.trim();
    if (!propString) return null;
    if (propString.startsWith('//') || propString.startsWith('/*')) return null;

    const match = propString.match(/^(\w+)(?:\s*=\s*(.+))?$/);
    if (!match) return null;

    const [, name, defaultValue] = match;
    if (['key', 'ref'].includes(name)) return null;

    return {
      name: name.trim(),
      type: this.inferType(defaultValue),
      required: !defaultValue,
      defaultValue: defaultValue ? this.cleanDefaultValue(defaultValue) : undefined,
      description: `${name} prop`
    };
  }

  /**
   * Regex: extract props from TypeScript interface declarations.
   */
  static extractFromInterface(code) {
    const props = [];
    const aliases = this.extractLocalAliases(code);

    const interfaceRegex = /interface\s+(\w+)(?:\s+extends[^{]+)?\s*\{/g;
    let match;

    while ((match = interfaceRegex.exec(code)) !== null) {
      const interfaceName = match[1];
      if (!interfaceName.includes('Props')) continue;

      const braceStart = match.index + match[0].lastIndexOf('{');
      const block = this.extractBraceBlock(code, braceStart);
      if (!block) continue;
      interfaceRegex.lastIndex = block.end;

      const parts = this.splitInterfaceBody(block.body);
      for (const part of parts) {
        const propMatch = part.match(/(\w+)(\??):\s*(.+)$/);
        if (!propMatch) continue;
        const name = propMatch[1];
        const optional = propMatch[2];
        const rawType = propMatch[3].trim();
        const mapped = this.mapTypeRich(rawType, aliases);
        const prop = {
          name,
          type: mapped.type,
          required: !optional,
          description: `${name} prop`
        };
        if (mapped.options) prop.options = mapped.options;
        props.push(prop);
      }
    }

    return props;
  }

  /**
   * Regex: extract props from TypeScript type aliases (type X = { ... } / & { ... }).
   */
  static extractFromTypeAlias(code) {
    const props = [];
    const aliases = this.extractLocalAliases(code);
    const typeRegex = /type\s+(\w+)\s*=\s*/g;
    let match;

    while ((match = typeRegex.exec(code)) !== null) {
      const typeName = match[1];
      if (!typeName.includes('Props')) continue;

      const semi = code.indexOf(';', typeRegex.lastIndex);
      const braceStart = code.indexOf('{', typeRegex.lastIndex);
      if (braceStart < 0) continue;
      if (semi !== -1 && braceStart > semi) continue;

      const block = this.extractBraceBlock(code, braceStart);
      if (!block) continue;
      typeRegex.lastIndex = block.end;

      const parts = this.splitInterfaceBody(block.body);
      for (const part of parts) {
        const propMatch = part.match(/(\w+)(\??):\s*(.+)$/);
        if (!propMatch) continue;
        const name = propMatch[1];
        const optional = propMatch[2];
        const rawType = propMatch[3].trim();
        const mapped = this.mapTypeRich(rawType, aliases);
        const prop = {
          name,
          type: mapped.type,
          required: !optional,
          description: `${name} prop`
        };
        if (mapped.options) prop.options = mapped.options;
        props.push(prop);
      }
    }

    return props;
  }

  /**
   * Regex fallback entry point.
   */
  static _extractWithRegex(code) {
    const destructuredProps = this.extractFromFunctionDestructuring(code);
    const interfaceProps = this.extractFromInterface(code);
    const typeAliasProps = this.extractFromTypeAlias(code);
    return this._mergeProps([...destructuredProps, ...interfaceProps, ...typeAliasProps]);
  }


  // ═══════════════════════════════════════════════════════════════════════
  // Shared utilities (backward compatible, used by both AST and regex)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Infer type from a default value string representation.
   */
  static inferType(defaultValue) {
    if (!defaultValue) return 'any';

    const cleanValue = defaultValue.trim();

    if (cleanValue.startsWith('"') || cleanValue.startsWith("'")) return 'string';
    if (cleanValue === 'true' || cleanValue === 'false') return 'boolean';
    if (cleanValue !== '' && !isNaN(Number(cleanValue))) return 'number';
    if (cleanValue.startsWith('[')) return 'array';
    if (cleanValue.startsWith('{')) return 'object';

    return 'any';
  }

  /**
   * Clean a default value string (strip quotes, etc.).
   */
  static cleanDefaultValue(value) {
    if (!value) return undefined;

    let cleanValue = value.trim();

    if ((cleanValue.startsWith('"') && cleanValue.endsWith('"')) ||
        (cleanValue.startsWith("'") && cleanValue.endsWith("'"))) {
      cleanValue = cleanValue.slice(1, -1);
    }

    return cleanValue;
  }

  /**
   * Extract string literal values from a union type string.
   * E.g. `'default' | 'accent' | 'outline'` -> ['default', 'accent', 'outline']
   * Returns null if the type is not a pure string-literal union.
   */
  static parseStringLiterals(rawType) {
    try {
      const raw = String(rawType || '').trim();
      if (!raw.includes("'") && !raw.includes('"')) return null;
      const parts = raw.split('|').map(p => p.trim()).filter(p => p && p !== 'undefined');
      if (parts.length === 0) return null;
      const literals = [];
      for (const p of parts) {
        const m = /^'([^']*)'$/.exec(p) || /^"([^"]*)"$/.exec(p);
        if (!m) return null;
        literals.push(m[1]);
      }
      return literals.length > 0 ? literals : null;
    } catch { return null; }
  }

  /**
   * Regex: extract local type aliases that resolve to string-literal unions.
   * E.g. `type ButtonVariant = 'default' | 'accent';` -> { ButtonVariant: ['default', 'accent'] }
   */
  static extractLocalAliases(code) {
    const map = {};
    try {
      const re = /(?:export\s+)?type\s+([A-Za-z0-9_]+)\s*=\s*([^;\n{]+);/g;
      let m;
      while ((m = re.exec(code)) !== null) {
        const name = m[1];
        // Don't skip Props-suffixed names — they might be string unions
        // e.g. type ButtonProps = 'sm' | 'md'; parseStringLiterals handles non-union safely
        const rhs = m[2].trim();
        const literals = this.parseStringLiterals(rhs);
        if (literals) map[name] = literals;
      }
    } catch {}
    return map;
  }

  /**
   * Rich type mapping from a raw type string: returns { type, options? }.
   * Resolves local aliases and inline string-literal unions.
   */
  static mapTypeRich(rawType, aliases) {
    try {
      const raw = String(rawType || '').trim();
      if (!raw) return { type: 'any' };

      // Check local type alias first (e.g. ButtonVariant -> ['default', 'accent'])
      if (aliases && aliases[raw]) return { type: 'select', options: aliases[raw] };

      // Inline string-literal union: 'a' | 'b' | 'c'
      const literals = this.parseStringLiterals(raw);
      if (literals && literals.length > 0) return { type: 'select', options: literals };

      // Fallback: simple type mapping (no options)
      if (/\bstring\b/.test(raw)) return { type: 'string' };
      if (/\bnumber\b/.test(raw)) return { type: 'number' };
      if (/\bboolean\b/.test(raw)) return { type: 'boolean' };
      if (/\bReactNode\b|\bReact\.ReactNode\b|\bJSX\.Element\b/.test(raw)) return { type: 'node' };
      if (/\[\]$/.test(raw) || /\bArray<.+>/.test(raw)) return { type: 'array' };
      if (/^\{/.test(raw)) return { type: 'object' };
      // Preserve named type references (e.g. IconName, CustomType) so downstream
      // consumers like PropsEditor can recognize them for special controls.
      if (/^[A-Z][A-Za-z0-9_]*$/.test(raw)) return { type: raw };
      return { type: 'any' };
    } catch {
      return { type: 'any' };
    }
  }

  /**
   * Legacy mapper (backward compat). Delegates to mapTypeRich.
   */
  static mapTypeToSimple(type) {
    return this.mapTypeRich(type, {}).type;
  }

  /**
   * Merge duplicate prop entries.
   * Interface/type-alias provides richer type info (options),
   * destructuring provides defaultValue. Combine both.
   */
  static _mergeProps(props) {
    const uniqueProps = [];
    const seenMap = new Map();

    for (const prop of props) {
      if (seenMap.has(prop.name)) {
        const idx = seenMap.get(prop.name);
        const existing = uniqueProps[idx];
        // Prefer options from richer source (interface/type alias)
        if (prop.options && !existing.options) existing.options = prop.options;
        // Upgrade type: 'select' always wins; otherwise prefer non-'any' types
        if (prop.type === 'select' && existing.type !== 'select') {
          existing.type = prop.type;
        } else if (existing.type === 'any' && prop.type !== 'any') {
          existing.type = prop.type;
        }
        // Interface/type-alias required (based on ?) is more authoritative than
        // destructuring guess (based on whether a default exists).
        // If interface says optional (required=false), propagate that.
        if (prop.required === false && existing.required === true) {
          existing.required = false;
        }
        // Preserve defaultValue from destructuring if interface didn't provide one
        if (existing.defaultValue === undefined && prop.defaultValue !== undefined) existing.defaultValue = prop.defaultValue;
      } else {
        seenMap.set(prop.name, uniqueProps.length);
        uniqueProps.push({ ...prop });
      }
    }

    return uniqueProps;
  }


  // ═══════════════════════════════════════════════════════════════════════
  // Main entry point
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Extract props from React component source code.
   * Uses Babel AST when available, falls back to regex.
   *
   * @param {string} code - Component source code
   * @param {string} [framework='react'] - Framework (only 'react' supported)
   * @returns {Array<{name, type, required, defaultValue?, options?, description}>}
   */
  static extract(code, framework = 'react') {
    if (framework !== 'react') return [];

    // Primary: AST-based extraction
    const ast = this._parseAST(code);
    if (ast) {
      try {
        const result = this._extractWithAST(ast);
        if (result && result.length > 0) return result;
      } catch (e) {
        // AST extraction failed — fall through to regex
      }
    }

    // Fallback: regex-based extraction
    return this._extractWithRegex(code);
  }
}

// Browser global — set on window for IIFE/script-tag usage (Playground sandbox)
if (typeof window !== 'undefined') {
  window.PropExtractor = PropExtractor;
}

// Loaded via <script> tag — do NOT use ESM export here.
// For bundler/Node usage, import from the engine package entry point.
