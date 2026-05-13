/**
 * Storybook CSF (Component Story Format) Parser
 *
 * Parses CSF 2.0 and 3.0 format files using regex-based extraction.
 * Handles .stories.tsx, .stories.jsx, .stories.ts files.
 */

// ─── Types ───────────────────────────────────────────────────

export interface CsfParseResult {
  title?: string;
  componentImportPath: string | null;
  argTypes: Record<string, CsfArgType>;
  defaultArgs: Record<string, unknown>;
  stories: CsfStory[];
}

export interface CsfStory {
  /** Export name, e.g. "Primary" */
  name: string;
  /** Readable name, e.g. "Primary" */
  displayName: string;
  args: Record<string, unknown>;
  hasRenderFn: boolean;
  hasPlayFn: boolean;
}

export interface CsfArgType {
  control?: string;
  options?: unknown[];
  defaultValue?: unknown;
  description?: string;
}

// ─── Helpers ─────────────────────────────────────────────────

/** Strip single-line and multi-line comments from source */
function stripComments(src: string): string {
  // Remove block comments but not inside strings
  let result = '';
  let i = 0;
  let inString: string | null = null;
  let inTemplate = false;

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    // Handle string state
    if (!inString && !inTemplate) {
      if (ch === '`') {
        inTemplate = true;
        result += ch;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = ch;
        result += ch;
        i++;
        continue;
      }
      // Block comment
      if (ch === '/' && next === '*') {
        const end = src.indexOf('*/', i + 2);
        i = end === -1 ? src.length : end + 2;
        continue;
      }
      // Line comment
      if (ch === '/' && next === '/') {
        const end = src.indexOf('\n', i + 2);
        i = end === -1 ? src.length : end;
        continue;
      }
    } else if (inTemplate) {
      if (ch === '`' && src[i - 1] !== '\\') {
        inTemplate = false;
      }
    } else if (inString) {
      if (ch === inString && src[i - 1] !== '\\') {
        inString = null;
      }
    }

    result += ch;
    i++;
  }

  return result;
}

/**
 * Parse a JS object literal from source text (lightweight — handles common cases).
 * Returns parsed object or empty object on failure.
 */
function parseObjectLiteral(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  try {
    // Normalize: replace single quotes with double, handle trailing commas,
    // unquoted keys, undefined values
    let normalized = trimmed;

    // Wrap unquoted keys: word: → "word":
    normalized = normalized.replace(
      /(?<=[\{,]\s*)([a-zA-Z_$][\w$]*)\s*:/g,
      '"$1":',
    );

    // Replace single-quoted strings with double-quoted
    normalized = normalized.replace(
      /'([^'\\]*(?:\\.[^'\\]*)*)'/g,
      '"$1"',
    );

    // Remove trailing commas before } or ]
    normalized = normalized.replace(/,\s*([}\]])/g, '$1');

    // Replace undefined with null
    normalized = normalized.replace(/:\s*undefined/g, ': null');

    // Replace unquoted true/false/null (already valid JSON, no-op)
    return JSON.parse(normalized);
  } catch {
    // Fallback: extract simple key-value pairs
    return parseSimpleObject(trimmed);
  }
}

/** Fallback parser for simple key: value pairs */
function parseSimpleObject(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  // Match key: 'value', key: "value", key: number, key: true/false
  const pairRe =
    /(\w+)\s*:\s*(?:'([^']*)'|"([^"]*)"|(\d+(?:\.\d+)?)|(\btrue\b|\bfalse\b|\bnull\b|\bundefined\b)|\[([^\]]*)\])/g;
  let match: RegExpExecArray | null;

  while ((match = pairRe.exec(text)) !== null) {
    const key = match[1];
    if (match[2] !== undefined) result[key] = match[2]; // single-quoted string
    else if (match[3] !== undefined) result[key] = match[3]; // double-quoted string
    else if (match[4] !== undefined) result[key] = Number(match[4]); // number
    else if (match[5] !== undefined) {
      const v = match[5];
      result[key] =
        v === 'true' ? true : v === 'false' ? false : v === 'null' ? null : undefined;
    } else if (match[6] !== undefined) {
      // Simple array of strings/numbers
      try {
        const arrStr = '[' + match[6].replace(/'/g, '"') + ']';
        result[key] = JSON.parse(arrStr.replace(/,\s*]/, ']'));
      } catch {
        result[key] = match[6];
      }
    }
  }

  return result;
}

/**
 * Extract a balanced brace block starting at `startIndex` in `src`.
 * `src[startIndex]` must be '{'.
 * Returns the content between (and including) the braces, or null.
 */
function extractBalancedBraces(src: string, startIndex: number): string | null {
  if (src[startIndex] !== '{') return null;

  let depth = 0;
  let inString: string | null = null;
  let inTemplate = false;

  for (let i = startIndex; i < src.length; i++) {
    const ch = src[i];
    const prev = i > 0 ? src[i - 1] : '';

    if (!inString && !inTemplate) {
      if (ch === '`') { inTemplate = true; continue; }
      if (ch === '"' || ch === "'") { inString = ch; continue; }
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) return src.slice(startIndex, i + 1);
      }
    } else if (inTemplate) {
      if (ch === '`' && prev !== '\\') inTemplate = false;
    } else if (inString) {
      if (ch === inString && prev !== '\\') inString = null;
    }
  }

  return null;
}

/** Convert PascalCase/camelCase to readable name */
export function storyNameToDisplayName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
}

// ─── Meta extraction ─────────────────────────────────────────

interface MetaInfo {
  title?: string;
  componentName?: string;
  argTypes: Record<string, CsfArgType>;
  defaultArgs: Record<string, unknown>;
}

function extractMeta(src: string): MetaInfo {
  const result: MetaInfo = { argTypes: {}, defaultArgs: {} };

  // Find default export — either `export default { ... }` or `export default meta`
  // Also handle `const meta = { ... } satisfies Meta<...>; export default meta;`
  // and `const meta: Meta<...> = { ... }; export default meta;`

  let metaObjectStr: string | null = null;

  // Pattern 1: export default { ... }
  const directDefaultRe = /export\s+default\s+\{/;
  const directMatch = directDefaultRe.exec(src);
  if (directMatch) {
    const braceStart = directMatch.index + directMatch[0].length - 1;
    metaObjectStr = extractBalancedBraces(src, braceStart);
  }

  // Pattern 2: export default someVar — find that variable
  if (!metaObjectStr) {
    const varDefaultRe = /export\s+default\s+(\w+)\s*;/;
    const varMatch = varDefaultRe.exec(src);
    if (varMatch) {
      const varName = varMatch[1];
      // Find: const varName = { ... } or const varName: ... = { ... }
      const varDefRe = new RegExp(
        `(?:const|let|var)\\s+${varName}[^=]*=\\s*\\{`,
      );
      const varDefMatch = varDefRe.exec(src);
      if (varDefMatch) {
        const braceStart =
          varDefMatch.index + varDefMatch[0].length - 1;
        metaObjectStr = extractBalancedBraces(src, braceStart);
      }
    }
  }

  if (!metaObjectStr) return result;

  // Extract title
  const titleRe = /title\s*:\s*(?:'([^']*)'|"([^"]*)")/;
  const titleMatch = titleRe.exec(metaObjectStr);
  if (titleMatch) {
    result.title = titleMatch[1] ?? titleMatch[2];
  }

  // Extract component name
  const componentRe = /component\s*:\s*(\w+)/;
  const componentMatch = componentRe.exec(metaObjectStr);
  if (componentMatch) {
    result.componentName = componentMatch[1];
  }

  // Extract args
  const argsRe = /\bargs\s*:\s*\{/;
  const argsMatch = argsRe.exec(metaObjectStr);
  if (argsMatch) {
    const braceStart = argsMatch.index + argsMatch[0].length - 1;
    const argsStr = extractBalancedBraces(metaObjectStr, braceStart);
    if (argsStr) {
      result.defaultArgs = parseObjectLiteral(argsStr);
    }
  }

  // Extract argTypes
  const argTypesRe = /argTypes\s*:\s*\{/;
  const argTypesMatch = argTypesRe.exec(metaObjectStr);
  if (argTypesMatch) {
    const braceStart =
      argTypesMatch.index + argTypesMatch[0].length - 1;
    const argTypesStr = extractBalancedBraces(metaObjectStr, braceStart);
    if (argTypesStr) {
      result.argTypes = parseArgTypes(argTypesStr);
    }
  }

  return result;
}

/** Parse argTypes object: { propName: { control: 'text', ... }, ... } */
function parseArgTypes(argTypesStr: string): Record<string, CsfArgType> {
  const result: Record<string, CsfArgType> = {};

  // Find each top-level property in the argTypes object
  // Match: propName: { ... }
  const propRe = /(\w+)\s*:\s*\{/g;
  let match: RegExpExecArray | null;
  // Remove the outer braces
  const inner = argTypesStr.slice(1, -1);

  while ((match = propRe.exec(inner)) !== null) {
    const propName = match[1];
    const braceStart = match.index + match[0].length - 1;
    const block = extractBalancedBraces(inner, braceStart);
    if (!block) continue;

    const argType: CsfArgType = {};

    // control — can be string or object { type: 'select' }
    const controlStringRe = /control\s*:\s*(?:'([^']*)'|"([^"]*)")/;
    const controlStringMatch = controlStringRe.exec(block);
    if (controlStringMatch) {
      argType.control = controlStringMatch[1] ?? controlStringMatch[2];
    } else {
      const controlObjRe = /control\s*:\s*\{[^}]*type\s*:\s*(?:'([^']*)'|"([^"]*)")/;
      const controlObjMatch = controlObjRe.exec(block);
      if (controlObjMatch) {
        argType.control = controlObjMatch[1] ?? controlObjMatch[2];
      }
    }

    // options
    const optionsRe = /options\s*:\s*\[([^\]]*)\]/;
    const optionsMatch = optionsRe.exec(block);
    if (optionsMatch) {
      try {
        const arrStr = '[' + optionsMatch[1].replace(/'/g, '"') + ']';
        argType.options = JSON.parse(arrStr.replace(/,\s*]/, ']'));
      } catch {
        // best effort
      }
    }

    // defaultValue
    const defValRe =
      /defaultValue\s*:\s*(?:'([^']*)'|"([^"]*)"|(\d+(?:\.\d+)?)|(\btrue\b|\bfalse\b|\bnull\b))/;
    const defValMatch = defValRe.exec(block);
    if (defValMatch) {
      if (defValMatch[1] !== undefined) argType.defaultValue = defValMatch[1];
      else if (defValMatch[2] !== undefined) argType.defaultValue = defValMatch[2];
      else if (defValMatch[3] !== undefined) argType.defaultValue = Number(defValMatch[3]);
      else if (defValMatch[4] !== undefined) {
        const v = defValMatch[4];
        argType.defaultValue = v === 'true' ? true : v === 'false' ? false : null;
      }
    }

    // description
    const descRe = /description\s*:\s*(?:'([^']*)'|"([^"]*)")/;
    const descMatch = descRe.exec(block);
    if (descMatch) {
      argType.description = descMatch[1] ?? descMatch[2];
    }

    result[propName] = argType;
  }

  return result;
}

// ─── Component import path detection ─────────────────────────

function findComponentImportPath(
  src: string,
  componentName: string | undefined,
): string | null {
  if (!componentName) return null;

  // import ComponentName from './path'
  // import { ComponentName } from './path'
  // import { Something as ComponentName } from './path'
  const patterns = [
    new RegExp(
      `import\\s+${componentName}\\s+from\\s+(?:'([^']+)'|"([^"]+)")`,
    ),
    new RegExp(
      `import\\s*\\{[^}]*\\b${componentName}\\b[^}]*\\}\\s*from\\s+(?:'([^']+)'|"([^"]+)")`,
    ),
  ];

  for (const re of patterns) {
    const m = re.exec(src);
    if (m) return m[1] ?? m[2];
  }

  return null;
}

// ─── Story extraction ────────────────────────────────────────

/** Reserved names that are not stories */
const RESERVED_EXPORTS = new Set([
  'default',
  '__namedExportsOrder',
  'decorators',
  'parameters',
  'loaders',
]);

function extractStories(src: string, defaultArgs: Record<string, unknown>): CsfStory[] {
  const stories: CsfStory[] = [];
  const seen = new Set<string>();

  // CSF 3.0 — object stories: export const Primary = { args: {...}, render: ..., play: ... }
  // Also handle: export const Primary: Story = { ... }
  const csf3Re =
    /export\s+const\s+(\w+)\s*(?::\s*\w+(?:<[^>]*>)?\s*)?=\s*\{/g;
  let m: RegExpExecArray | null;

  while ((m = csf3Re.exec(src)) !== null) {
    const name = m[1];
    if (RESERVED_EXPORTS.has(name) || seen.has(name)) continue;

    const braceStart = m.index + m[0].length - 1;
    const block = extractBalancedBraces(src, braceStart);
    if (!block) continue;

    // Skip if it looks like a meta definition (has `title:` and `component:`)
    if (/\btitle\s*:/.test(block) && /\bcomponent\s*:/.test(block)) continue;

    seen.add(name);

    let args: Record<string, unknown> = {};
    const argsRe = /\bargs\s*:\s*\{/;
    const argsMatch = argsRe.exec(block);
    if (argsMatch) {
      const argsBrace = argsMatch.index + argsMatch[0].length - 1;
      const argsStr = extractBalancedBraces(block, argsBrace);
      if (argsStr) {
        args = parseObjectLiteral(argsStr);
      }
    }

    const hasRenderFn = /\brender\s*[:(\s]/.test(block);
    const hasPlayFn = /\bplay\s*[:(\s]/.test(block);

    stories.push({
      name,
      displayName: storyNameToDisplayName(name),
      args: { ...defaultArgs, ...args },
      hasRenderFn,
      hasPlayFn,
    });
  }

  // CSF 2.0 — Template.bind stories: export const Primary = Template.bind({})
  const csf2BindRe =
    /export\s+const\s+(\w+)\s*=\s*\w+\.bind\s*\(\s*\{?\s*\}?\s*\)/g;

  while ((m = csf2BindRe.exec(src)) !== null) {
    const name = m[1];
    if (RESERVED_EXPORTS.has(name) || seen.has(name)) continue;
    seen.add(name);

    // Look for: StoryName.args = { ... }
    let args: Record<string, unknown> = {};
    const argsAssignRe = new RegExp(`${name}\\.args\\s*=\\s*\\{`);
    const argsAssignMatch = argsAssignRe.exec(src);
    if (argsAssignMatch) {
      const braceStart =
        argsAssignMatch.index + argsAssignMatch[0].length - 1;
      const argsStr = extractBalancedBraces(src, braceStart);
      if (argsStr) {
        args = parseObjectLiteral(argsStr);
      }
    }

    stories.push({
      name,
      displayName: storyNameToDisplayName(name),
      args: { ...defaultArgs, ...args },
      hasRenderFn: false,
      hasPlayFn: false,
    });
  }

  // CSF 2.0 — arrow/function stories: export const Primary = (args) => <Component {...args} />
  // Only catch ones not already seen
  const csf2FnRe =
    /export\s+const\s+(\w+)\s*(?::\s*\w+(?:<[^>]*>)?\s*)?=\s*(?:\(|function)/g;

  while ((m = csf2FnRe.exec(src)) !== null) {
    const name = m[1];
    if (RESERVED_EXPORTS.has(name) || seen.has(name)) continue;
    // Skip Template itself
    if (name === 'Template') continue;
    seen.add(name);

    // Look for StoryName.args = { ... }
    let args: Record<string, unknown> = {};
    const argsAssignRe = new RegExp(`${name}\\.args\\s*=\\s*\\{`);
    const argsAssignMatch = argsAssignRe.exec(src);
    if (argsAssignMatch) {
      const braceStart =
        argsAssignMatch.index + argsAssignMatch[0].length - 1;
      const argsStr = extractBalancedBraces(src, braceStart);
      if (argsStr) {
        args = parseObjectLiteral(argsStr);
      }
    }

    stories.push({
      name,
      displayName: storyNameToDisplayName(name),
      args: { ...defaultArgs, ...args },
      hasRenderFn: true,
      hasPlayFn: false,
    });
  }

  return stories;
}

// ─── Main API ────────────────────────────────────────────────

/**
 * Parse a Storybook CSF file and extract component metadata, argTypes,
 * default args, and story definitions.
 */
export function parseCsfFile(source: string, _filePath: string): CsfParseResult {
  const cleaned = stripComments(source);

  const meta = extractMeta(cleaned);

  const componentImportPath = findComponentImportPath(
    cleaned,
    meta.componentName,
  );

  const stories = extractStories(cleaned, meta.defaultArgs);

  return {
    title: meta.title,
    componentImportPath,
    argTypes: meta.argTypes,
    defaultArgs: meta.defaultArgs,
    stories,
  };
}
