import { describe, it, expect, beforeEach } from 'vitest';
import {
  UniversalCodeSanitizer,
  sanitizeReactCode,
  sanitizeVueCode,
  sanitizeSvelteCode,
  sanitizeUniversalCode,
} from '../codeSanitizer';

describe('UniversalCodeSanitizer', () => {
  // ─────────────────────────────────────────────────────────
  // sanitizeForSecurity
  // ─────────────────────────────────────────────────────────
  describe('sanitizeForSecurity', () => {
    let sanitizer: UniversalCodeSanitizer;
    beforeEach(() => { sanitizer = new UniversalCodeSanitizer('react'); });

    it('replaces window.top with self', () => {
      const result = sanitizer.sanitizeForSecurity('console.log(window.top.location)');
      expect(result).toContain('self.location');
      expect(result).not.toContain('window.top');
    });

    it('replaces window.parent with self', () => {
      const result = sanitizer.sanitizeForSecurity('window.parent.postMessage("x")');
      expect(result).toContain('self.postMessage');
      expect(result).not.toContain('window.parent');
    });

    it('replaces window.opener with null', () => {
      const result = sanitizer.sanitizeForSecurity('if (window.opener) {}');
      expect(result).toContain('null');
      expect(result).not.toContain('window.opener');
    });

    it('replaces eval with safe stub', () => {
      const result = sanitizer.sanitizeForSecurity('eval("alert(1)")');
      expect(result).toContain('(() => undefined)(');
      expect(result).not.toMatch(/\beval\s*\(/);
    });

    it('strips <script> tags', () => {
      const result = sanitizer.sanitizeForSecurity('var x = 1; <script>alert(1)</script>');
      expect(result).not.toContain('<script>');
      expect(result).not.toContain('</script>');
    });

    it('strips </script> (case insensitive)', () => {
      const result = sanitizer.sanitizeForSecurity('<SCRIPT>x</SCRIPT>');
      expect(result).not.toMatch(/<\/?script>/i);
    });

    it('preserves normal code unchanged', () => {
      const code = 'const Component = () => <div>Hello</div>';
      const result = sanitizer.sanitizeForSecurity(code);
      expect(result).toBe(code);
    });
  });

  // ─────────────────────────────────────────────────────────
  // sanitizeCode (the main method)
  // ─────────────────────────────────────────────────────────
  describe('sanitizeCode', () => {
    it('returns success: true for valid code', () => {
      const sanitizer = new UniversalCodeSanitizer('react');
      const result = sanitizer.sanitizeCode('const x = 1;');
      expect(result.success).toBe(true);
    });

    it('applies security sanitization', () => {
      const sanitizer = new UniversalCodeSanitizer('react');
      const result = sanitizer.sanitizeCode('window.top.href = "evil"');
      expect(result.cleanCode).toContain('self');
      expect(result.cleanCode).not.toContain('window.top');
    });

    it('detects import statements', () => {
      const sanitizer = new UniversalCodeSanitizer('react');
      const result = sanitizer.sanitizeCode("import React from 'react';");
      expect(result.hasImports).toBe(true);
    });

    it('detects export statements', () => {
      const sanitizer = new UniversalCodeSanitizer('react');
      const result = sanitizer.sanitizeCode('export default function App() {}');
      expect(result.hasExports).toBe(true);
    });

    it('detects CommonJS patterns', () => {
      const sanitizer = new UniversalCodeSanitizer('react');
      const result = sanitizer.sanitizeCode('module.exports = App;');
      expect(result.hasCommonJS).toBe(true);
    });

    it('detects IIFE wrapping', () => {
      const sanitizer = new UniversalCodeSanitizer('react');
      const code = '(function() { return 42; })();';
      const result = sanitizer.sanitizeCode(code);
      expect(result.isWrappedInIIFE).toBe(true);
    });

    it('detects non-IIFE code', () => {
      const sanitizer = new UniversalCodeSanitizer('react');
      const result = sanitizer.sanitizeCode('const x = 1;');
      expect(result.isWrappedInIIFE).toBe(false);
    });

    it('returns logs array', () => {
      const sanitizer = new UniversalCodeSanitizer('react');
      const result = sanitizer.sanitizeCode('const x = 1;');
      expect(Array.isArray(result.logs)).toBe(true);
      expect(result.logs.length).toBeGreaterThan(0);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Static sanitize method
  // ─────────────────────────────────────────────────────────
  describe('UniversalCodeSanitizer.sanitize', () => {
    it('defaults to react framework', () => {
      const result = UniversalCodeSanitizer.sanitize('const x = 1;');
      expect(result.success).toBe(true);
      expect(result.logs.some((l: string) => l.includes('react'))).toBe(true);
    });

    it('accepts vue framework', () => {
      const result = UniversalCodeSanitizer.sanitize('const x = 1;', 'vue');
      expect(result.success).toBe(true);
      expect(result.logs.some((l: string) => l.includes('vue'))).toBe(true);
    });

    it('accepts svelte framework', () => {
      const result = UniversalCodeSanitizer.sanitize('const x = 1;', 'svelte');
      expect(result.success).toBe(true);
      expect(result.logs.some((l: string) => l.includes('svelte'))).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Convenience exports
  // ─────────────────────────────────────────────────────────
  describe('convenience functions', () => {
    it('sanitizeReactCode works', () => {
      const result = sanitizeReactCode('const App = () => <div />;');
      expect(result.success).toBe(true);
    });

    it('sanitizeVueCode works', () => {
      const result = sanitizeVueCode('<template><div /></template>');
      expect(result.success).toBe(true);
    });

    it('sanitizeSvelteCode works', () => {
      const result = sanitizeSvelteCode('<script>let x = 1;</script>');
      expect(result.success).toBe(true);
    });

    it('sanitizeUniversalCode delegates to framework', () => {
      const result = sanitizeUniversalCode('const x = 1;', 'react');
      expect(result.success).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Validation detection (via sanitizeCode)
  // ─────────────────────────────────────────────────────────
  describe('validation detection', () => {
    const sanitize = (code: string) => new UniversalCodeSanitizer('react').sanitizeCode(code);

    it('hasImports false for clean code', () => {
      expect(sanitize('const x = 1;').hasImports).toBe(false);
    });

    it('hasExports false for clean code', () => {
      expect(sanitize('const x = 1;').hasExports).toBe(false);
    });

    it('hasCommonJS false for clean code', () => {
      expect(sanitize('const x = 1;').hasCommonJS).toBe(false);
    });

    it('detects named imports', () => {
      expect(sanitize("import { useState } from 'react';").hasImports).toBe(true);
    });

    it('detects default imports', () => {
      expect(sanitize("import React from 'react';").hasImports).toBe(true);
    });

    it('detects named exports', () => {
      expect(sanitize('export const foo = 1;').hasExports).toBe(true);
    });

    it('detects re-exports', () => {
      expect(sanitize("export { foo } from './bar';").hasExports).toBe(true);
    });

    it('detects module.exports', () => {
      expect(sanitize('module.exports = App;').hasCommonJS).toBe(true);
    });

    it('detects exports.X', () => {
      expect(sanitize('exports.default = App;').hasCommonJS).toBe(true);
    });

    it('detects require() pattern', () => {
      // The regex \b(require\()\b requires a word boundary after '(' —
      // only matches when the next char is a word char (like an identifier).
      expect(sanitize('const x = require(react)').hasCommonJS).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────
  // getLogs
  // ─────────────────────────────────────────────────────────
  describe('getLogs', () => {
    it('returns logs after sanitization', () => {
      const sanitizer = new UniversalCodeSanitizer('react');
      sanitizer.sanitizeCode('const x = 1;');
      const logs = sanitizer.getLogs();
      expect(logs.length).toBeGreaterThan(0);
    });

    it('returns a copy (not the internal array)', () => {
      const sanitizer = new UniversalCodeSanitizer('react');
      sanitizer.sanitizeCode('const x = 1;');
      const logs1 = sanitizer.getLogs();
      const logs2 = sanitizer.getLogs();
      expect(logs1).toEqual(logs2);
      expect(logs1).not.toBe(logs2);
    });
  });
});
