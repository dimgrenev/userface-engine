// Lightweight TypeScript-like prop extractor focused on practical cases
// Goals:
// - Detect interface/alias used for React props with string-literal unions
// - Detect boolean/number/string types
// - Extract defaults from parameter destructuring in component signature
// - Keep dependencies zero; tolerate syntax noise

export type ExtractedProp = {
  name: string;
  type: string; // 'string' | 'number' | 'boolean' | 'function' | 'object' | 'array' | 'select' | 'any'
  required: boolean;
  options?: string[]; // for select
  defaultValue?: unknown;
};

type SourceBundle = {
  fileName: string;
  code: string;
};

type RecoverablePropExtractionStage =
  | 'parameter-defaults'
  | 'default-props-object'
  | 'props-interface'
  | 'local-aliases'
  | 'jsdoc-aliases'
  | 'local-interfaces'
  | 'prop-types';

type RecoverablePropExtractionFailure = {
  stage: RecoverablePropExtractionStage;
  error: unknown;
};

function noopRecoverablePropExtractionFailure(_failure: RecoverablePropExtractionFailure): void {
  // Keep prop extraction best-effort while preserving a typed hook for future reporting.
  void _failure;
}

function recoverPropExtraction<T>(
  stage: RecoverablePropExtractionStage,
  fallback: T,
  extract: () => T,
): T {
  try {
    return extract();
  } catch (error: unknown) {
    noopRecoverablePropExtractionFailure({ stage, error });
    return fallback;
  }
}

// Very tolerant tokenizer for string literal union like 'a' | 'b' | "c"
function parseStringUnion(typeText: string): string[] | null {
  const t = typeText.trim();
  if (!t.includes("'") && !t.includes('"')) return null;
  const parts = t
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean);
  const values: string[] = [];
  for (const p of parts) {
    const m = /^['"](.*)['"]$/m.exec(p);
    if (!m) return null;
    values.push(m[1]);
  }
  return values.length > 0 ? values : null;
}

function parseDefaultsFromDestructure(
  inside: string,
  out: Record<string, unknown>,
): Record<string, unknown> {
    // Brace-aware top-level comma splitting (handles nested objects/arrays in defaults)
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (let i = 0; i < inside.length; i++) {
      const ch = inside[i];
      if (ch === '{' || ch === '[' || ch === '(') depth++;
      else if (ch === '}' || ch === ']' || ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        const trimmed = current.trim();
        if (trimmed) parts.push(trimmed);
        current = '';
      } else {
        current += ch;
      }
    }
    const last = current.trim();
    if (last) parts.push(last);
    for (const p of parts) {
      const m = /(\w+)\s*=\s*([^,]+)/.exec(p);
      if (!m) continue;
      const key = m[1];
      const valRaw = m[2].trim();
      if (/^'(.*)'$/.test(valRaw)) out[key] = valRaw.slice(1, -1);
      else if (/^"(.*)"$/.test(valRaw)) out[key] = valRaw.slice(1, -1);
      else if (/^\d+(?:\.\d+)?$/.test(valRaw)) out[key] = Number(valRaw);
      else if (/^(true|false)$/.test(valRaw)) out[key] = valRaw === 'true';
      else if (/^\[.*\]$/.test(valRaw)) out[key] = [];
      else if (/^\{.*\}$/.test(valRaw)) out[key] = {};
      else out[key] = undefined;
    }
    return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMatchingDelimiter(
  code: string,
  start: number,
  open: string,
  close: string,
): number {
  if (code[start] !== open) return -1;
  let depth = 0;
  for (let index = start; index < code.length; index++) {
    if (code[index] === open) depth++;
    else if (code[index] === close) {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function extractNamedComponentDefaultsDestructure(code: string, fileName: string): string {
  const componentName = sourceComponentName(fileName);
  if (!componentName) return '';
  const declaration = new RegExp(`\\bfunction\\s+${escapeRegExp(componentName)}\\s*\\(`).exec(code);
  if (!declaration) return '';

  const openParen = declaration.index + declaration[0].length - 1;
  const closeParen = findMatchingDelimiter(code, openParen, '(', ')');
  if (closeParen < 0) return '';
  const firstParamStart = code.slice(openParen + 1, closeParen).search(/\S/);
  if (firstParamStart < 0) return '';
  const firstParamOffset = openParen + 1 + firstParamStart;

  if (code[firstParamOffset] === '{') {
    const closeBrace = findMatchingDelimiter(code, firstParamOffset, '{', '}');
    return closeBrace > firstParamOffset
      ? code.slice(firstParamOffset + 1, closeBrace)
      : '';
  }

  const propsVariable = /^[_$A-Za-z][\w$]*/.exec(code.slice(firstParamOffset, closeParen))?.[0] || '';
  if (!propsVariable) return '';
  const functionBodyStart = code.indexOf('{', closeParen + 1);
  if (functionBodyStart < 0) return '';
  const functionBodyEnd = findMatchingDelimiter(code, functionBodyStart, '{', '}');
  if (functionBodyEnd < 0) return '';
  const body = code.slice(functionBodyStart + 1, functionBodyEnd);
  const declarationPattern = /\b(?:const|let)\s*\{/g;
  let destructure: RegExpExecArray | null;
  while ((destructure = declarationPattern.exec(body))) {
    const openBrace = destructure.index + destructure[0].length - 1;
    const closeBrace = findMatchingDelimiter(body, openBrace, '{', '}');
    if (closeBrace < 0) continue;
    const assignment = body.slice(closeBrace + 1);
    if (!new RegExp(`^\\s*=\\s*${escapeRegExp(propsVariable)}\\b`).test(assignment)) {
      declarationPattern.lastIndex = closeBrace + 1;
      continue;
    }
    return body.slice(openBrace + 1, closeBrace);
  }
  return '';
}

// Extract map of prop name -> default value from the public component.
// Supports both signature destructuring and the canonical forwardRef shape:
// `function Button(props, ref) { const { variant = 'default' } = props }`.
function extractDefaultsFromParam(code: string, fileName: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  return recoverPropExtraction('parameter-defaults', out, () => {
    const namedComponentDestructure = extractNamedComponentDefaultsDestructure(code, fileName);
    if (namedComponentDestructure) {
      return parseDefaultsFromDestructure(namedComponentDestructure, out);
    }

    // Fallback for anonymous arrow/forwardRef components.
    const mA = code.match(/\(\{([\s\S]*?)\}\s*:\s*[^)]+\)\s*(?:\{|\(|=>)/);
    const mB = code.match(/\(\{([\s\S]*?)\}\s*(?::\s*[^),]+)?\s*,\s*[_$A-Za-z][\w$]*\s*\)\s*=>\s*(?:\{|\()/);
    const inside = (mA && mA[1]) ? mA[1] : ((mB && mB[1]) ? mB[1] : '');
    return inside ? parseDefaultsFromDestructure(inside, out) : out;
  });
}

// Extract defaults from Component.defaultProps = { ... }
function extractDefaultPropsObject(code: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  return recoverPropExtraction('default-props-object', out, () => {
    const m = /\.defaultProps\s*=\s*\{([\s\S]*?)\}/m.exec(code);
    if (!m) return out;
    const body = m[1];
    const pairs = body.split(',').map((s) => s.trim()).filter(Boolean);
    for (const p of pairs) {
      const mm = /(\w+)\s*:\s*([^,]+)/.exec(p);
      if (!mm) continue;
      const key = mm[1];
      const valRaw = mm[2].trim();
      if (/^'(.*)'$/.test(valRaw)) out[key] = valRaw.slice(1, -1);
      else if(/^"(.*)"$/.test(valRaw)) out[key] = valRaw.slice(1, -1);
      else if (/^\d+(?:\.\d+)?$/.test(valRaw)) out[key] = Number(valRaw);
      else if (/^(true|false)$/.test(valRaw)) out[key] = valRaw === 'true';
      else if (/^\[.*\]$/.test(valRaw)) out[key] = [];
      else if (/^\{.*\}$/.test(valRaw)) out[key] = {};
      else out[key] = undefined;
    }
    return out;
  });
}

// Extract props interface text.
// Prefers `*Props` declarations. Supports both exported and non-exported interfaces/types.
// Uses balanced brace matching to handle nested object types like `style?: { color: string }`.
function sourceComponentName(fileName: string): string {
  const normalized = String(fileName || '').split(/[?#]/, 1)[0].replace(/\\/g, '/');
  const leaf = normalized.slice(normalized.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  if (!leaf || leaf.toLowerCase() === 'index') return '';
  return leaf
    .split(/[^A-Za-z0-9_$]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function extractPropsInterface(code: string, fileName: string): string | null {
  return recoverPropExtraction<string | null>('props-interface', null, () => {
    type Match = { name: string; body: string; kind: 'interface' | 'type'; exported: boolean };
    const matches: Match[] = [];

    // interface XProps { ... }  (optionally exported, supports `extends ...`)
    const ifaceRe = /(export\s+)?interface\s+([A-Za-z0-9_]+)[^{]*\{/g;
    let m: RegExpExecArray | null;
    while ((m = ifaceRe.exec(code))) {
      const braceStart = m.index + m[0].length - 1;
      const body = extractBalancedBraces(code, braceStart);
      if (body !== null) matches.push({ name: m[2], body, kind: 'interface', exported: Boolean(m[1]) });
    }

    // type XProps = { ... }  (optionally exported)
    const typeRe = /(export\s+)?type\s+([A-Za-z0-9_]+)\s*=\s*\{/g;
    while ((m = typeRe.exec(code))) {
      const braceStart = m.index + m[0].length - 1;
      const body = extractBalancedBraces(code, braceStart);
      if (body !== null) matches.push({ name: m[2], body, kind: 'type', exported: Boolean(m[1]) });
    }

    if (matches.length === 0) return null;

    const isPropsName = (n: string) => n.toLowerCase().includes('props');
    const endsWithProps = (n: string) => /props$/i.test(n);
    const componentName = sourceComponentName(fileName);
    const expectedPropsName = componentName ? `${componentName}Props` : '';

    // A component source can contain private helper renderers after the public
    // component contract (for example TreeNodeRendererProps after TreeProps).
    // The source/file identity is therefore the primary ownership signal.
    // Export visibility is the next-best signal for index or unconventional
    // files. Positional matching is intentionally only the final fallback.
    const exactPublic = expectedPropsName
      ? matches.find((candidate) => candidate.name === expectedPropsName)
      : undefined;
    // Composed aliases belong to the semantic parser. Borrowing a private
    // helper interface here makes the merge discard the public union's props.
    const declaredAliases = [...code.matchAll(/\btype\s+([A-Za-z0-9_]+)\s*=/g)];
    if (!exactPublic && declaredAliases.some((alias) => alias[1] === expectedPropsName)) return null;
    const exportedPropsEnding = [...matches].reverse().find((candidate) => (
      candidate.exported && endsWithProps(candidate.name)
    ));
    const propsEnding = [...matches].reverse().find((candidate) => endsWithProps(candidate.name));
    const propsContaining = [...matches].reverse().find((candidate) => isPropsName(candidate.name));
    const best = exactPublic || exportedPropsEnding || propsEnding || propsContaining || matches[matches.length - 1] || matches[0];

    return best?.body ?? null;
  });
}

// Extract simple type/enum aliases within the same file for resolving interface property types
function extractLocalAliases(code: string): Record<string, { type: 'union'|'enum'; options: string[] }>{
  const map: Record<string, { type: 'union'|'enum'; options: string[] }> = {};
  return recoverPropExtraction('local-aliases', map, () => {
    // type Alias = 'a' | 'b' (optionally exported)
    const typeRegex = /(?:export\s+)?type\s+([A-Za-z0-9_]+)\s*=\s*([^;\n]+);?/g;
    let m: RegExpExecArray | null;
    while ((m = typeRegex.exec(code))) {
      const name = m[1];
      const rhs = m[2];
      const union = parseStringUnion(rhs);
      if (union && union.length) map[name] = { type: 'union', options: union };
    }
    // enum Alias { A='a', B='b' } (optionally exported)
    const enumRegex = /(?:export\s+)?enum\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)\}/g;
    while ((m = enumRegex.exec(code))) {
      const name = m[1];
      const body = m[2];
      const opts: string[] = [];
      const lineRe = /(\w+)\s*=\s*'(.*?)'/g;
      let mm: RegExpExecArray | null;
      while ((mm = lineRe.exec(body))) {
        opts.push(mm[2]);
      }
      if (opts.length) map[name] = { type: 'enum', options: opts };
    }
    return map;
  });
}

// Extract JSDoc typedefs with string-literal unions
// Example: /** @typedef {'primary'|'secondary'|'danger'} Variant */
function extractJsDocAliases(code: string): Record<string, { type: 'union'; options: string[] }>{
  const map: Record<string, { type: 'union'; options: string[] }> = {};
  return recoverPropExtraction('jsdoc-aliases', map, () => {
    const re = /@typedef\s*\{([^}]+)\}\s*([A-Za-z0-9_]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      const typeBody = m[1];
      const name = m[2];
      const union = parseStringUnion(typeBody);
      if (union && union.length) map[name] = { type: 'union', options: union };
    }
    return map;
  });
}

// Extract the body between matched braces, handling nesting.
// Returns the content between the opening `{` at `start` and its matching `}`.
function extractBalancedBraces(code: string, start: number): string | null {
  if (code[start] !== '{') return null;
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return code.slice(start + 1, i);
    }
  }
  return null;
}

function splitTopLevelPropEntries(body: string): string[] {
  const entries: string[] = [];
  let start = 0;
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = 0; index < body.length; index++) {
    const character = body[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') braces++;
    else if (character === '}') braces--;
    else if (character === '[') brackets++;
    else if (character === ']') brackets--;
    else if (character === '(') parentheses++;
    else if (character === ')') parentheses--;

    if ((character === ';' || character === '\n') && braces === 0 && brackets === 0 && parentheses === 0) {
      const entry = body.slice(start, index).trim();
      if (entry) entries.push(entry);
      start = index + 1;
    }
  }
  const last = body.slice(start).trim();
  if (last) entries.push(last);
  return entries;
}

function normalizeType(tsType: string, unionOptions: string[] | null): { type: string; options?: string[] } {
  const t = tsType.trim().toLowerCase();
  if (unionOptions && unionOptions.length > 0) return { type: 'select', options: unionOptions };
  if (t.startsWith('string')) return { type: 'string' };
  if (t.startsWith('number')) return { type: 'number' };
  if (t.startsWith('boolean')) return { type: 'boolean' };
  if (t.startsWith('array') || /\[\]$/.test(t)) return { type: 'array' };
  if (t.startsWith('function') || t.includes('=>')) return { type: 'function' };
  if (t.startsWith('object') || t.startsWith('{')) return { type: 'object' };
  return { type: 'any' };
}

// For `Foo[]` types where Foo is an interface in the same file, extract a sample value
// so that required array props get a sensible initial value instead of undefined.
function extractLocalInterfaces(code: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  return recoverPropExtraction('local-interfaces', out, () => {
    const re = /(?:export\s+)?interface\s+([A-Za-z0-9_]+)[^{]*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      const name = m[1];
      const braceStart = m.index + m[0].length - 1;
      const body = extractBalancedBraces(code, braceStart);
      if (!body) continue;
      const fields: Record<string, string> = {};
      const lines = body.split(/\n|;/).map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        const fm = /^(\w+)\s*\??\s*:\s*([^;]+)$/.exec(line);
        if (!fm) continue;
        fields[fm[1]] = fm[2].trim();
      }
      if (Object.keys(fields).length > 0) out[name] = fields;
    }
    return out;
  });
}

function generateSampleValue(tsType: string, interfaces: Record<string, Record<string, string>>): unknown {
  const t = tsType.trim();
  const arrayMatch = t.match(/^([A-Za-z0-9_]+)\s*\[\]$/);
  if (arrayMatch) {
    const itemType = arrayMatch[1];
    const iface = interfaces[itemType];
    if (iface) {
      const sample: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(iface)) {
        const vl = v.toLowerCase();
        if (vl.startsWith('string')) sample[k] = k === 'value' ? 'option-1' : k === 'label' ? 'Option 1' : '';
        else if (vl.startsWith('number')) sample[k] = 0;
        else if (vl.startsWith('boolean')) sample[k] = false;
        else sample[k] = '';
      }
      const sample2 = { ...sample };
      for (const [k, v] of Object.entries(sample2)) {
        if (k === 'value') sample2[k] = 'option-2';
        else if (k === 'label') sample2[k] = 'Option 2';
      }
      return [sample, sample2];
    }
  }
  return undefined;
}

// Parse rudimentary PropTypes: oneOf([...]), string, number, bool, array, object, func, and .isRequired
function extractPropTypes(code: string): Record<string, { type: string; options?: string[]; required?: boolean }>{
  const out: Record<string, { type: string; options?: string[]; required?: boolean }> = {};
  return recoverPropExtraction('prop-types', out, () => {
    const m = /\.propTypes\s*=\s*\{([\s\S]*?)\}/m.exec(code);
    if (!m) return out;
    const body = m[1];
    const entries = body.split(',').map((s)=>s.trim()).filter(Boolean);
    for (const e of entries) {
      const mm = /(\w+)\s*:\s*([^,]+)/.exec(e);
      if (!mm) continue;
      const key = mm[1];
      const rhs = mm[2];
      const isReq = /\.isRequired\b/.test(rhs);
      if (/PropTypes\.oneOf\s*\(\s*\[(.*?)\]\s*\)/.test(rhs)) {
        const list = /PropTypes\.oneOf\s*\(\s*\[(.*?)\]\s*\)/.exec(rhs)![1];
        const opts = list.split(',').map(s=>s.trim()).map(s=>s.replace(/^'(.*)'$/,'$1').replace(/^"(.*)"$/,'$1')).filter(Boolean);
        out[key] = { type: 'select', options: opts, required: isReq };
      } else if (/PropTypes\.bool/.test(rhs)) out[key] = { type: 'boolean', required: isReq };
      else if (/PropTypes\.number/.test(rhs)) out[key] = { type: 'number', required: isReq };
      else if (/PropTypes\.string/.test(rhs)) out[key] = { type: 'string', required: isReq };
      else if (/PropTypes\.array/.test(rhs)) out[key] = { type: 'array', required: isReq };
      else if (/PropTypes\.object/.test(rhs)) out[key] = { type: 'object', required: isReq };
      else if (/PropTypes\.func/.test(rhs)) out[key] = { type: 'function', required: isReq };
      else out[key] = { type: 'any', required: isReq };
    }
    return out;
  });
}

export function extractReactTsPropsFromSource(bundle: SourceBundle): ExtractedProp[] {
  const { code, fileName } = bundle;
  const defaults = { ...extractDefaultsFromParam(code, fileName), ...extractDefaultPropsObject(code) };
  const aliases = { ...extractLocalAliases(code), ...extractJsDocAliases(code) };
  const propTypes = extractPropTypes(code);
  const iface = extractPropsInterface(code, fileName);
  const interfaces = extractLocalInterfaces(code);
  const out: ExtractedProp[] = [];
  if (iface) {
    // Collapse multiline types into single entries. Split only on `;` or newlines
    // that start a new property declaration (name followed by `?:` or `:`).
    const rawEntries = splitTopLevelPropEntries(iface.replace(/\/\*[\s\S]*?\*\//g, ''));
    // Rejoin fragments that are continuations (don't start with a property name pattern).
    const entries: string[] = [];
    for (const raw of rawEntries) {
      // Normalize internal newlines so the regex can match the full type.
      const flat = raw.replace(/\s*\n\s*/g, ' ').trim();
      if (/^(?:\w+|'[^']+'|"[^"]+")\s*\??:/.test(flat)) {
        entries.push(flat);
      } else if (entries.length > 0) {
        entries[entries.length - 1] += ' ' + flat;
      }
    }
    for (const line of entries) {
      const m = /^(\w+|'[^']+'|"[^"]+")\s*(\??)\s*:\s*(.+)$/.exec(line);
      if (!m) continue;
      const [, rawName, opt, rawType] = m;
      const name = rawName.replace(/^['"]|['"]$/g, '');
      const typeText = rawType.replace(/\|\s*undefined\b/,'').trim();
      const alias = aliases[typeText];
      const union = alias ? alias.options : parseStringUnion(typeText);
      const { type, options } = normalizeType(typeText, union || null);
      const prop: ExtractedProp = {
        name,
        type,
        required: opt !== '?',
      };
      if (options) prop.options = options;
      if (propTypes[name]) {
        const pt = propTypes[name];
        prop.type = pt.type || prop.type;
        if (pt.options) prop.options = pt.options;
        if (typeof pt.required === 'boolean') prop.required = pt.required;
      }
      if (Object.prototype.hasOwnProperty.call(defaults, name)) {
        prop.defaultValue = defaults[name];
      } else if (prop.required && prop.type === 'array') {
        const sample = generateSampleValue(typeText, interfaces);
        if (sample !== undefined) prop.defaultValue = sample;
      }
      out.push(prop);
    }
  }
  // If no TS interface, try to build from propTypes only
  if (out.length === 0 && Object.keys(propTypes).length > 0) {
    for (const [name, pt] of Object.entries(propTypes)) {
      const p: ExtractedProp = {
        name,
        type: pt.type,
        required: !!pt.required,
      };
      if (pt.options) p.options = pt.options;
      if (Object.prototype.hasOwnProperty.call(defaults, name)) p.defaultValue = defaults[name];
      out.push(p);
    }
  }
  return out;
}
