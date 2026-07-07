/**
 * StatefulFaceUi — React component that renders face schema v1 documents with local state management.
 *
 * Supports:
 * - `doc.state` — local state accessible via `$ref: "state.key"`
 * - Built-in actions: setState, toggle, navigate, submit, log
 * - Custom actions via `onAction` callback
 */

import React, { useState, useCallback, useMemo } from 'react';
import type { FaceUiRenderEnv, FaceUiRegistry, FaceJsonValue } from './types';
import { renderFaceUiToReact } from './react';

interface StatefulFaceUiProps {
  /** The face schema v1 document to render */
  doc: any;
  /** Component registry (library + user components) */
  registry: FaceUiRegistry;
  /** External context/props accessible via $ref: "props.*" or "context.*" */
  context?: any;
  /** Custom action handler — called for actions not handled by builtins */
  onAction?: (action: string, args: any, ctx: any) => void;
  /** Called when document state changes (for external sync) */
  onStateChange?: (state: Record<string, any>) => void;
}

/** Resolve a dot-path like "state.email" or "props.title" from a context object */
function resolveRefPath(ref: string, context: any): any {
  const parts = String(ref || '').split('.');
  let cur = context;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

export function StatefulFaceUi({ doc, registry, context, onAction, onStateChange }: StatefulFaceUiProps) {
  // Stable key for detecting when doc.state definition changes (new doc loaded).
  const stateFingerprint = useMemo(() => {
    try { return JSON.stringify(doc?.state || {}); } catch { return '{}'; }
  }, [doc?.state]);

  const [docState, setDocState] = useState<Record<string, any>>(() => {
    try {
      return (doc && typeof doc.state === 'object' && !Array.isArray(doc.state))
        ? { ...doc.state }
        : {};
    } catch { return {}; }
  });

  // Re-initialize state when a different doc is loaded (state definition changes).
  React.useEffect(() => {
    try {
      const next = (doc && typeof doc.state === 'object' && !Array.isArray(doc.state))
        ? { ...doc.state }
        : {};
      setDocState(next);
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateFingerprint]);

  const dispatch = useCallback((action: string, args: FaceJsonValue | undefined, ctx: any) => {
    const a = String(action || '').trim();
    const argsObj = (args && typeof args === 'object' && !Array.isArray(args)) ? args as Record<string, any> : {};

    switch (a) {
      case 'setState': {
        const key = String(argsObj.key || '');
        if (!key) break;
        setDocState(prev => {
          // Value resolution order:
          // 1. Explicit value in $action args: { "$action": "setState", "args": { "key": "x", "value": 42 } }
          // 2. Event payload from component callback (e.g. onValueChange({ value: "text" }))
          // 3. Raw ctx if it's a primitive (e.g. onValueChange("text"))
          const value = 'value' in argsObj
            ? argsObj.value
            : (ctx && typeof ctx === 'object' && 'value' in ctx)
              ? ctx.value
              : ctx;
          const next = { ...prev, [key]: value };
          onStateChange?.(next);
          return next;
        });
        break;
      }
      case 'toggle': {
        const key = String(argsObj.key || '');
        if (!key) break;
        setDocState(prev => {
          const next = { ...prev, [key]: !prev[key] };
          onStateChange?.(next);
          return next;
        });
        break;
      }
      case 'navigate': {
        const path = String(argsObj.path || argsObj.url || '');
        if (path) {
          try { window.location.href = path; } catch {}
        }
        break;
      }
      case 'submit': {
        onAction?.('submit', { state: docState, ...argsObj }, ctx);
        break;
      }
      case 'log': {
        const msg = argsObj.message || 'FaceUi action';
        console.log(`[FaceUi] ${msg}`, { state: docState, args: argsObj, ctx });
        break;
      }
      default: {
        // Forward unknown actions to custom handler
        onAction?.(a, args, ctx);
      }
    }
  }, [docState, onAction, onStateChange]);

  const resolveRef = useCallback((ref: string, ctx: any) => {
    // Support state.* refs
    if (ref.startsWith('state.')) {
      const key = ref.slice(6); // Remove "state."
      return resolveRefPath(key, docState);
    }
    // Default: resolve from context
    return resolveRefPath(ref, ctx);
  }, [docState]);

  const env: FaceUiRenderEnv = useMemo(() => ({
    registry,
    actions: { dispatch },
    context: context || {},
    resolveRef,
  }), [registry, dispatch, context, resolveRef]);

  try {
    return renderFaceUiToReact(doc, env);
  } catch (err: any) {
    return React.createElement('div', {
      style: { padding: 16, color: '#e55', fontSize: 13, fontFamily: 'monospace' },
    }, `FaceUi render error: ${err?.message || err}`);
  }
}
