import type { ExtractedProp } from './react.js';

const VUE_SVELTE_PROP_EXTRACTOR_RECOVERABLE_LIMIT = 24;

type VueSveltePropExtractorRecoverableOperation = 'extract-vue-props' | 'extract-svelte-props';

type VueSveltePropExtractorRecoverableEvidence = {
  operation: VueSveltePropExtractorRecoverableOperation;
  fallback: 'empty-props';
  sourceLength: number;
  errorName?: string;
  errorMessage: string;
};

const vueSveltePropExtractorRecoverableEvidence: VueSveltePropExtractorRecoverableEvidence[] = [];

function recoverableErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message?: unknown }).message || '').trim();
    if (message) return message;
  }
  return fallback;
}

function recordVueSveltePropExtractorRecoverable(
  operation: VueSveltePropExtractorRecoverableOperation,
  error: unknown,
  source: string,
): void {
  vueSveltePropExtractorRecoverableEvidence.push({
    operation,
    fallback: 'empty-props',
    sourceLength: source.length,
    errorName: error instanceof Error ? error.name : undefined,
    errorMessage: recoverableErrorMessage(error, 'Vue/Svelte prop extraction recoverable failure'),
  });
  if (vueSveltePropExtractorRecoverableEvidence.length > VUE_SVELTE_PROP_EXTRACTOR_RECOVERABLE_LIMIT) {
    vueSveltePropExtractorRecoverableEvidence.splice(
      0,
      vueSveltePropExtractorRecoverableEvidence.length - VUE_SVELTE_PROP_EXTRACTOR_RECOVERABLE_LIMIT,
    );
  }
}

const strUnion = (t: string): string[] | null => {
  const parts = t.split('|').map(s => s.trim());
  if (!parts.every(p => /^'(.*)'$/.test(p))) return null;
  return parts.map(p => p.slice(1, -1));
};

const normalize = (typeText: string, union: string[] | null) => {
  const t = (typeText || '').trim().toLowerCase();
  if (union && union.length) return { type: 'select', options: union } as const;
  if (t.startsWith('string')) return { type: 'string' } as const;
  if (t.startsWith('number')) return { type: 'number' } as const;
  if (t.startsWith('boolean')) return { type: 'boolean' } as const;
  if (t.includes('=>')) return { type: 'function' } as const;
  if (t.endsWith('[]')) return { type: 'array' } as const;
  if (t.startsWith('{')) return { type: 'object' } as const;
  return { type: 'any' } as const;
};

type NormalizedPropType = ReturnType<typeof normalize>;

function normalizedOptions(type: NormalizedPropType): string[] | undefined {
  return 'options' in type ? type.options : undefined;
}

export function extractVuePropsFromSFC(sfc: string): ExtractedProp[] {
  try {
    const script = (() => {
      const m = /<script[^>]*>([\s\s]*?)<\/script>/i.exec(sfc);
      return m ? m[1] : sfc;
    })();
    // withDefaults(defineProps<...>(), { ... })
    const withDef = /withDefaults\s*\(\s*defineProps\s*<([^>]+)>\(\)\s*,\s*\{([\s\S]*?)\}\s*\)/m.exec(script);
    const defMap: Record<string, unknown> = {};
    if (withDef) {
      const body = withDef[2];
      body.split(',').map(s => s.trim()).filter(Boolean).forEach(p => {
        const mm = /(\w+)\s*:\s*([^,]+)/.exec(p);
        if (!mm) return;
        const key = mm[1];
        const val = mm[2].trim();
        if (/^'(.*)'$/.test(val)) defMap[key] = val.slice(1, -1);
        else if (/^\d+(?:\.\d+)?$/.test(val)) defMap[key] = Number(val);
        else if (/^(true|false)$/.test(val)) defMap[key] = val === 'true';
        else if (/^\[.*\]$/.test(val)) defMap[key] = [];
        else if (/^\{.*\}$/.test(val)) defMap[key] = {};
      });
    }
    // defineProps<...>() generic
    const gen = /defineProps\s*<([^>]+)>\s*\(\s*\)/m.exec(script);
    if (gen) {
      const body = gen[1];
      // Try interface-like: { name?: 'a'|'b' | string; }
      const fields = body.replace(/^type\s+\w+\s*=\s*/,'').replace(/^\{([\s\S]*?)\}$/m,'$1');
      const lines = fields.split(/\n|;/).map(l => l.trim()).filter(Boolean);
      const out: ExtractedProp[] = [];
      for (const line of lines) {
        const m = /^(\w+)\s*(\??)\s*:\s*([^;]+)$/.exec(line);
        if (!m) continue;
        const [, name, opt, typeText] = m;
        const union = strUnion(typeText);
        const t = normalize(typeText, union);
        const prop: ExtractedProp = { name, type: t.type, required: opt !== '?' } as ExtractedProp;
        const options = normalizedOptions(t);
        if (options) prop.options = options;
        if (Object.prototype.hasOwnProperty.call(defMap, name)) prop.defaultValue = defMap[name];
        out.push(prop);
      }
      return out;
    }
    // defineProps({ name: { type: String, required: false, default: '...' }, ... })
    const objM = /defineProps\s*\(\s*\{([\s\S]*?)\}\s*\)/m.exec(script);
    if (objM) {
      const body = objM[1];
      const out: ExtractedProp[] = [];
      const re = /(\w+)\s*:\s*\{([\s\S]*?)\}/g;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(body))) {
        const name = mm[1];
        const cfg = mm[2];
        const type = /type\s*:\s*(String|Number|Boolean|Array|Object|Function)/.exec(cfg)?.[1] || 'any';
        const required = /required\s*:\s*true/.test(cfg);
        const def = /default\s*:\s*([^,}]+)/.exec(cfg)?.[1]?.trim();
        const prop: ExtractedProp = { name, type: type.toLowerCase(), required } as ExtractedProp;
        if (def) {
          if (/^'(.*)'$/.test(def)) prop.defaultValue = def.slice(1,-1);
          else if (/^(true|false)$/.test(def)) prop.defaultValue = def === 'true';
          else if (/^\d+(?:\.\d+)?$/.test(def)) prop.defaultValue = Number(def);
        }
        out.push(prop);
      }
      return out;
    }
  } catch (error: unknown) {
    recordVueSveltePropExtractorRecoverable('extract-vue-props', error, sfc);
  }
  return [];
}

export function extractSvelteProps(source: string): ExtractedProp[] {
  try {
    const out: ExtractedProp[] = [];
    const re = /export\s+let\s+(\w+)(?::\s*([^=;]+))?(?:\s*=\s*([^;]+))?\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
      const name = m[1];
      const typeText = (m[2] || '').trim();
      const defRaw = (m[3] || '').trim();
      const union = strUnion(typeText);
      const t = normalize(typeText, union);
      const prop: ExtractedProp = { name, type: t.type, required: false } as ExtractedProp;
      const options = normalizedOptions(t);
      if (options) prop.options = options;
      if (defRaw) {
        if (/^'(.*)'$/.test(defRaw)) prop.defaultValue = defRaw.slice(1, -1);
        else if (/^(true|false)$/.test(defRaw)) prop.defaultValue = defRaw === 'true';
        else if (/^\d+(?:\.\d+)?$/.test(defRaw)) prop.defaultValue = Number(defRaw);
      }
      out.push(prop);
    }
    return out;
  } catch (error: unknown) {
    recordVueSveltePropExtractorRecoverable('extract-svelte-props', error, source);
  }
  return [];
}
