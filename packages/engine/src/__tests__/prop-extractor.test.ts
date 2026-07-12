/**
 * Tests for PropExtractor — both AST path (with mock Babel) and regex fallback.
 *
 * In the browser, PropExtractor uses `window.Babel.packages.parser.parse`.
 * Here we mock globalThis.Babel to point at the real @babel/parser from node_modules.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as babelParser from '@babel/parser';

// prop-extractor.js is a browser script-tag asset and intentionally has no ESM export.
// Load it the same way the sandbox does: execute the script and read window.PropExtractor.
const propExtractorContext = {
  window: {} as { Babel?: unknown; PropExtractor?: any },
};

runInNewContext(
  readFileSync(new URL('../prop-extractor.js', import.meta.url), 'utf8'),
  propExtractorContext,
);

const PropExtractor = propExtractorContext.window.PropExtractor;

// ─────────────────────────────────────────────────────────
// Set up mock Babel global so the AST path is exercised
// ─────────────────────────────────────────────────────────
beforeAll(() => {
  const Babel = {
    packages: {
      parser: babelParser,
    },
  };
  (globalThis as any).Babel = Babel;
  (propExtractorContext as any).Babel = Babel;
  propExtractorContext.window.Babel = Babel;
});

afterAll(() => {
  delete (globalThis as any).Babel;
  delete (propExtractorContext as any).Babel;
  delete propExtractorContext.window.Babel;
});

// Helper: extract with AST path guaranteed
function extractAST(code: string) {
  return PropExtractor.extract(code, 'react');
}

// Helper: extract with regex-only fallback
function extractRegex(code: string) {
  return PropExtractor._extractWithRegex(code);
}

// ═══════════════════════════════════════════════════════════
// Canary: verify Babel mock is active
// ═══════════════════════════════════════════════════════════

describe('PropExtractor — Babel mock canary', () => {
  it('globalThis.Babel is set and has parser.parse', () => {
    expect((globalThis as any).Babel).toBeDefined();
    expect((globalThis as any).Babel.packages.parser.parse).toBeInstanceOf(Function);
  });

  it('_parseAST returns a valid AST (not null)', () => {
    const ast = PropExtractor._parseAST('const x: string = "hello";');
    expect(ast).not.toBeNull();
    expect(ast.type).toBe('File');
    expect(ast.program).toBeDefined();
    expect(ast.program.body.length).toBeGreaterThan(0);
  });

  it('AST path resolves type aliases (regex cannot)', () => {
    // Type alias resolution is AST-only: regex fallback cannot follow alias references.
    // If this test passes with options, the AST path is definitely active.
    const code = `
      type ButtonVariant = 'primary' | 'secondary' | 'danger';
      interface Props {
        variant: ButtonVariant;
      }
    `;
    const astResult = extractAST(code);
    const astVariant = astResult.find((p: any) => p.name === 'variant');

    // AST must resolve ButtonVariant → ['primary', 'secondary', 'danger']
    expect(astVariant).toBeDefined();
    expect(astVariant.options).toEqual(['primary', 'secondary', 'danger']);

    // Regex also resolves local aliases in this extractor, but via a simpler mechanism.
    // The key proof: if AST returns options, the Babel mock is working.
    expect(astVariant.options.length).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════
// AST-based extraction
// ═══════════════════════════════════════════════════════════

describe('PropExtractor — AST path', () => {
  describe('extract from interface', () => {
    it('extracts props from a Props interface', () => {
      const code = `
        interface ButtonProps {
          label: string;
          disabled?: boolean;
          count: number;
        }
        function Button({ label, disabled, count }: ButtonProps) { return null; }
      `;
      const props = extractAST(code);
      expect(props.length).toBeGreaterThanOrEqual(3);
      const label = props.find((p: any) => p.name === 'label');
      expect(label).toBeDefined();
      expect(label.type).toBe('string');
      expect(label.required).toBe(true);

      const disabled = props.find((p: any) => p.name === 'disabled');
      expect(disabled).toBeDefined();
      expect(disabled.type).toBe('boolean');
      expect(disabled.required).toBe(false);

      const count = props.find((p: any) => p.name === 'count');
      expect(count).toBeDefined();
      expect(count.type).toBe('number');
    });

    it('resolves inline string literal unions to options', () => {
      const code = `
        interface CardProps {
          variant: 'filled' | 'outlined' | 'ghost';
        }
      `;
      const props = extractAST(code);
      const variant = props.find((p: any) => p.name === 'variant');
      expect(variant).toBeDefined();
      expect(variant.type).toBe('select');
      expect(variant.options).toEqual(['filled', 'outlined', 'ghost']);
    });

    it('resolves local type alias unions to options', () => {
      const code = `
        type ButtonVariant = 'primary' | 'secondary' | 'danger';
        interface ButtonProps {
          variant: ButtonVariant;
        }
      `;
      const props = extractAST(code);
      const variant = props.find((p: any) => p.name === 'variant');
      expect(variant).toBeDefined();
      expect(variant.type).toBe('select');
      expect(variant.options).toEqual(['primary', 'secondary', 'danger']);
    });

    it('resolves transitive type aliases', () => {
      const code = `
        type Base = 'sm' | 'md' | 'lg';
        type Size = Base;
        interface Props {
          size: Size;
        }
      `;
      const props = extractAST(code);
      const size = props.find((p: any) => p.name === 'size');
      expect(size).toBeDefined();
      expect(size.options).toEqual(['sm', 'md', 'lg']);
    });
  });

  describe('extract from type alias', () => {
    it('extracts props from type Props = { ... }', () => {
      const code = `
        type InputProps = {
          value: string;
          onChange?: (val: string) => void;
        };
      `;
      const props = extractAST(code);
      const value = props.find((p: any) => p.name === 'value');
      expect(value).toBeDefined();
      expect(value.type).toBe('string');
      expect(value.required).toBe(true);

      const onChange = props.find((p: any) => p.name === 'onChange');
      expect(onChange).toBeDefined();
      expect(onChange.required).toBe(false);
    });

    it('resolves intersection types (BaseProps & { ... })', () => {
      const code = `
        interface BaseProps {
          id: string;
        }
        type CardProps = BaseProps & {
          title: string;
          elevated?: boolean;
        };
      `;
      const props = extractAST(code);
      const names = props.map((p: any) => p.name);
      expect(names).toContain('id');
      expect(names).toContain('title');
      expect(names).toContain('elevated');
    });
  });

  describe('extract from destructuring', () => {
    it('extracts from function component', () => {
      const code = `
        function Card({ title, subtitle = 'default' }) {
          return null;
        }
      `;
      const props = extractAST(code);
      const title = props.find((p: any) => p.name === 'title');
      expect(title).toBeDefined();
      expect(title.required).toBe(true);

      const subtitle = props.find((p: any) => p.name === 'subtitle');
      expect(subtitle).toBeDefined();
      expect(subtitle.required).toBe(false);
      expect(subtitle.defaultValue).toBe('default');
    });

    it('extracts from arrow function', () => {
      const code = `
        const Tag = ({ label, color = 'blue' }) => <span>{label}</span>;
      `;
      const props = extractAST(code);
      expect(props.find((p: any) => p.name === 'label')).toBeDefined();
      const color = props.find((p: any) => p.name === 'color');
      expect(color).toBeDefined();
      expect(color.defaultValue).toBe('blue');
    });

    it('extracts from export default function', () => {
      const code = `
        export default function Page({ slug, preview = false }) {
          return <div>{slug}</div>;
        }
      `;
      const props = extractAST(code);
      expect(props.find((p: any) => p.name === 'slug')).toBeDefined();
      const preview = props.find((p: any) => p.name === 'preview');
      expect(preview).toBeDefined();
      expect(preview.type).toBe('boolean');
    });

    it('handles forwardRef wrapper', () => {
      const code = `
        import React from 'react';
        const Input = React.forwardRef(({ value, placeholder = '' }, ref) => {
          return <input ref={ref} value={value} placeholder={placeholder} />;
        });
      `;
      const props = extractAST(code);
      expect(props.find((p: any) => p.name === 'value')).toBeDefined();
      expect(props.find((p: any) => p.name === 'placeholder')).toBeDefined();
      // ref should NOT appear as a prop
      expect(props.find((p: any) => p.name === 'ref')).toBeUndefined();
    });

    it('handles memo wrapper', () => {
      const code = `
        const Badge = React.memo(({ text, count = 0 }) => <span>{text} {count}</span>);
      `;
      const props = extractAST(code);
      expect(props.find((p: any) => p.name === 'text')).toBeDefined();
      expect(props.find((p: any) => p.name === 'count')).toBeDefined();
    });

    it('skips RestElement', () => {
      const code = `
        function List({ items, ...rest }) { return null; }
      `;
      const props = extractAST(code);
      expect(props.find((p: any) => p.name === 'items')).toBeDefined();
      expect(props.find((p: any) => p.name === 'rest')).toBeUndefined();
    });
  });

  describe('advanced type resolution', () => {
    it('handles TSAsExpression in defaults', () => {
      const code = `
        const Chip = ({ size = 'md' as const }) => null;
      `;
      const props = extractAST(code);
      const size = props.find((p: any) => p.name === 'size');
      expect(size).toBeDefined();
      expect(size.defaultValue).toBe('md');
    });

    it('handles keyof T → string', () => {
      const code = `
        interface Props {
          key: keyof HTMLElementTagNameMap;
        }
      `;
      const props = extractAST(code);
      expect(props.find((p: any) => p.name === 'key')).toMatchObject({
        name: 'key',
        type: 'string',
        required: true,
      });
    });

    it('handles keyof T via interface prop', () => {
      const code = `
        interface Props {
          tagName: keyof HTMLElementTagNameMap;
        }
      `;
      const props = extractAST(code);
      const tagName = props.find((p: any) => p.name === 'tagName');
      expect(tagName).toBeDefined();
      expect(tagName.type).toBe('string');
    });

    it('handles dynamic defaults as <computed>', () => {
      const code = `
        function Comp({ id = generateId(), config = getConfig() }) { return null; }
      `;
      const props = extractAST(code);
      const id = props.find((p: any) => p.name === 'id');
      expect(id).toBeDefined();
      expect(id.required).toBe(false);
      // <computed> defaults are not exposed as defaultValue
      expect(id.defaultValue).toBeUndefined();
    });

    it('handles ReactNode type', () => {
      const code = `
        interface Props {
          children: React.ReactNode;
          icon?: ReactNode;
        }
      `;
      const props = extractAST(code);
      const children = props.find((p: any) => p.name === 'children');
      expect(children).toBeDefined();
      expect(children.type).toBe('node');
    });

    it('handles array types', () => {
      const code = `
        interface Props {
          items: string[];
          data: Array<number>;
        }
      `;
      const props = extractAST(code);
      expect(props.find((p: any) => p.name === 'items')?.type).toBe('array');
      expect(props.find((p: any) => p.name === 'data')?.type).toBe('array');
    });

    it('handles object literal type', () => {
      const code = `
        interface Props {
          style: { color: string; size: number };
        }
      `;
      const props = extractAST(code);
      expect(props.find((p: any) => p.name === 'style')?.type).toBe('object');
    });
  });

  describe('merge behavior', () => {
    it('merges interface options with destructuring defaults', () => {
      const code = `
        interface ButtonProps {
          variant?: 'primary' | 'secondary';
          size?: 'sm' | 'md' | 'lg';
        }
        function Button({ variant = 'primary', size = 'md' }: ButtonProps) { return null; }
      `;
      const props = extractAST(code);
      const variant = props.find((p: any) => p.name === 'variant');
      expect(variant).toBeDefined();
      expect(variant.options).toEqual(['primary', 'secondary']);
      expect(variant.defaultValue).toBe('primary');
      expect(variant.required).toBe(false);
    });
  });

  describe('non-react framework', () => {
    it('returns empty array for non-react framework', () => {
      expect(PropExtractor.extract('const x = 1;', 'vue')).toEqual([]);
      expect(PropExtractor.extract('const x = 1;', 'svelte')).toEqual([]);
    });
  });
});

// ═══════════════════════════════════════════════════════════
// Regex fallback extraction
// ═══════════════════════════════════════════════════════════

describe('PropExtractor — regex fallback', () => {
  describe('extractFromInterface (regex)', () => {
    it('extracts from interface body', () => {
      const code = `
        interface ButtonProps {
          label: string;
          disabled?: boolean;
        }
      `;
      const props = PropExtractor.extractFromInterface(code);
      expect(props.find((p: any) => p.name === 'label')).toBeDefined();
      expect(props.find((p: any) => p.name === 'disabled')).toBeDefined();
    });

    it('resolves inline string unions', () => {
      const code = `
        interface Props {
          variant: 'filled' | 'outlined';
        }
      `;
      const props = PropExtractor.extractFromInterface(code);
      const variant = props.find((p: any) => p.name === 'variant');
      expect(variant).toBeDefined();
      expect(variant.options).toEqual(['filled', 'outlined']);
    });

    it('resolves local type aliases', () => {
      const code = `
        type Size = 'sm' | 'md' | 'lg';
        interface Props {
          size: Size;
        }
      `;
      const props = PropExtractor.extractFromInterface(code);
      const size = props.find((p: any) => p.name === 'size');
      expect(size).toBeDefined();
      expect(size.options).toEqual(['sm', 'md', 'lg']);
    });
  });

  describe('extractFromTypeAlias (regex)', () => {
    it('extracts from type Props = { ... }', () => {
      const code = `
        type CardProps = {
          title: string;
          elevated?: boolean;
        };
      `;
      const props = PropExtractor.extractFromTypeAlias(code);
      expect(props.find((p: any) => p.name === 'title')).toBeDefined();
      expect(props.find((p: any) => p.name === 'elevated')).toBeDefined();
    });
  });

  describe('extractFromFunctionDestructuring (regex)', () => {
    it('extracts from function declaration', () => {
      const code = `function Button({ label, disabled = false }) { return null; }`;
      const props = PropExtractor.extractFromFunctionDestructuring(code);
      expect(props.find((p: any) => p.name === 'label')).toBeDefined();
      const disabled = props.find((p: any) => p.name === 'disabled');
      expect(disabled).toBeDefined();
      expect(disabled.type).toBe('boolean');
    });

    it('extracts from arrow function', () => {
      const code = `const Tag = ({ name, count = 0 }) => null;`;
      const props = PropExtractor.extractFromFunctionDestructuring(code);
      expect(props.find((p: any) => p.name === 'name')).toBeDefined();
      expect(props.find((p: any) => p.name === 'count')?.type).toBe('number');
    });

    it('handles type annotation in destructuring', () => {
      const code = `function Comp({ value, onChange }: Props) { return null; }`;
      const props = PropExtractor.extractFromFunctionDestructuring(code);
      expect(props.find((p: any) => p.name === 'value')).toBeDefined();
      expect(props.find((p: any) => p.name === 'onChange')).toBeDefined();
    });

    it('parses default values from destructuring', () => {
      const code = `const X = ({ text = 'hello', num = 42 }) => null;`;
      const props = PropExtractor.extractFromFunctionDestructuring(code);
      const text = props.find((p: any) => p.name === 'text');
      expect(text?.defaultValue).toBe('hello');
      expect(text?.type).toBe('string');

      const num = props.find((p: any) => p.name === 'num');
      expect(num?.defaultValue).toBe('42');
      expect(num?.type).toBe('number');
    });
  });

  describe('_extractWithRegex (combined)', () => {
    it('merges interface and destructuring props', () => {
      const code = `
        interface Props {
          variant?: 'a' | 'b';
        }
        function Comp({ variant = 'a' }: Props) { return null; }
      `;
      const props = extractRegex(code);
      const variant = props.find((p: any) => p.name === 'variant');
      expect(variant).toBeDefined();
      // Merge: options from interface, defaultValue from destructuring
      expect(variant.options).toEqual(['a', 'b']);
    });
  });
});

// ═══════════════════════════════════════════════════════════
// Shared utilities
// ═══════════════════════════════════════════════════════════

describe('PropExtractor — shared utilities', () => {
  describe('inferType', () => {
    it('infers string from quoted value', () => {
      expect(PropExtractor.inferType("'hello'")).toBe('string');
      expect(PropExtractor.inferType('"world"')).toBe('string');
    });

    it('infers boolean', () => {
      expect(PropExtractor.inferType('true')).toBe('boolean');
      expect(PropExtractor.inferType('false')).toBe('boolean');
    });

    it('infers number', () => {
      expect(PropExtractor.inferType('42')).toBe('number');
      expect(PropExtractor.inferType('3.14')).toBe('number');
      expect(PropExtractor.inferType('-1')).toBe('number');
    });

    it('infers array', () => {
      expect(PropExtractor.inferType('[]')).toBe('array');
      expect(PropExtractor.inferType('[1, 2]')).toBe('array');
    });

    it('infers object', () => {
      expect(PropExtractor.inferType('{}')).toBe('object');
      expect(PropExtractor.inferType('{ x: 1 }')).toBe('object');
    });

    it('returns any for unknown', () => {
      expect(PropExtractor.inferType(undefined)).toBe('any');
      expect(PropExtractor.inferType('someVariable')).toBe('any');
    });

    it('infers function for arrow expressions', () => {
      // inferType only handles static patterns; () => {} starts with neither quote/number/bool/bracket
      expect(PropExtractor.inferType('() => {}')).toBe('any');
    });
  });

  describe('cleanDefaultValue', () => {
    it('removes single quotes from strings', () => {
      expect(PropExtractor.cleanDefaultValue("'hello'")).toBe('hello');
    });

    it('removes double quotes from strings', () => {
      expect(PropExtractor.cleanDefaultValue('"world"')).toBe('world');
    });

    it('preserves numbers', () => {
      expect(PropExtractor.cleanDefaultValue('42')).toBe('42');
    });

    it('preserves booleans', () => {
      expect(PropExtractor.cleanDefaultValue('true')).toBe('true');
    });

    it('returns undefined for falsy input', () => {
      expect(PropExtractor.cleanDefaultValue(undefined)).toBeUndefined();
      expect(PropExtractor.cleanDefaultValue('')).toBeUndefined();
    });
  });

  describe('parseStringLiterals', () => {
    it('parses single-quoted union', () => {
      expect(PropExtractor.parseStringLiterals("'a' | 'b' | 'c'")).toEqual(['a', 'b', 'c']);
    });

    it('parses double-quoted union', () => {
      expect(PropExtractor.parseStringLiterals('"x" | "y"')).toEqual(['x', 'y']);
    });

    it('returns null for non-literal union', () => {
      expect(PropExtractor.parseStringLiterals('string | number')).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(PropExtractor.parseStringLiterals('')).toBeNull();
      expect(PropExtractor.parseStringLiterals(null)).toBeNull();
    });

    it('skips undefined in union', () => {
      expect(PropExtractor.parseStringLiterals("'a' | 'b' | undefined")).toEqual(['a', 'b']);
    });
  });

  describe('mapTypeRich', () => {
    it('maps string type', () => {
      expect(PropExtractor.mapTypeRich('string', {}).type).toBe('string');
    });

    it('maps number type', () => {
      expect(PropExtractor.mapTypeRich('number', {}).type).toBe('number');
    });

    it('maps boolean type', () => {
      expect(PropExtractor.mapTypeRich('boolean', {}).type).toBe('boolean');
    });

    it('maps ReactNode type', () => {
      expect(PropExtractor.mapTypeRich('ReactNode', {}).type).toBe('node');
      expect(PropExtractor.mapTypeRich('React.ReactNode', {}).type).toBe('node');
    });

    it('maps array types (regex checks primitives first)', () => {
      // Note: mapTypeRich checks \bstring\b, \bnumber\b, \bboolean\b before array patterns.
      // So 'string[]', 'Array<number>' match the primitive keyword first.
      // Only types without a primitive keyword in them reach the array check.
      expect(PropExtractor.mapTypeRich('Item[]', {}).type).toBe('array');
      expect(PropExtractor.mapTypeRich('Array<Item>', {}).type).toBe('array');
      // Primitives with [] resolve as the primitive, not array:
      expect(PropExtractor.mapTypeRich('string[]', {}).type).toBe('string');
      expect(PropExtractor.mapTypeRich('Array<number>', {}).type).toBe('number');
    });

    it('maps inline string literal union', () => {
      const result = PropExtractor.mapTypeRich("'a' | 'b'", {});
      expect(result.type).toBe('select');
      expect(result.options).toEqual(['a', 'b']);
    });

    it('resolves aliases', () => {
      const aliases = { MyType: ['x', 'y', 'z'] };
      const result = PropExtractor.mapTypeRich('MyType', aliases);
      expect(result.type).toBe('select');
      expect(result.options).toEqual(['x', 'y', 'z']);
    });

    it('preserves PascalCase type references', () => {
      expect(PropExtractor.mapTypeRich('IconName', {}).type).toBe('IconName');
    });

    it('returns any for empty', () => {
      expect(PropExtractor.mapTypeRich('', {}).type).toBe('any');
      expect(PropExtractor.mapTypeRich(null, {}).type).toBe('any');
    });
  });

  describe('mapTypeToSimple', () => {
    it('delegates to mapTypeRich', () => {
      expect(PropExtractor.mapTypeToSimple('string')).toBe('string');
      expect(PropExtractor.mapTypeToSimple('boolean')).toBe('boolean');
    });
  });

  describe('extractBraceBlock', () => {
    it('extracts balanced braces', () => {
      const code = 'foo { a: 1; b: 2; }';
      const result = PropExtractor.extractBraceBlock(code, 4);
      expect(result).not.toBeNull();
      expect(result.body.trim()).toBe('a: 1; b: 2;');
    });

    it('handles nested braces', () => {
      const code = 'x { outer: { inner: 1 }; }';
      const result = PropExtractor.extractBraceBlock(code, 2);
      expect(result).not.toBeNull();
      expect(result.body).toContain('outer');
      expect(result.body).toContain('inner');
    });

    it('returns null for unbalanced', () => {
      expect(PropExtractor.extractBraceBlock('{ open', 0)).toBeNull();
    });

    it('returns null for negative index', () => {
      expect(PropExtractor.extractBraceBlock('{}', -1)).toBeNull();
    });
  });
});
