import React from 'react';
import type { FaceUiActions, FaceUiDoc, FaceUiRenderEnv, FaceUiRegistry } from './types';
import { createFaceUiRegistry } from './registry';
import { renderFaceUiToReact } from './react';

export type FaceUiProps = {
  /** Face document in schema `face` version 1. */
  doc: FaceUiDoc;
  /**
   * Editable props/state for the UI document (from face.currentState.props, etc).
   * Exposed to $ref resolver as `context.props.*`.
   */
  props?: Record<string, any>;
  /** Arbitrary render context available to $ref resolver as `context.*`. */
  context?: any;
  /**
   * Component registry (type → React component).
   * Required unless `components` is provided.
   */
  registry?: FaceUiRegistry;
  /**
   * Convenience: provide components map and we will create a registry.
   * Prefer passing `registry` if you need sanitizers.
   */
  components?: Record<string, React.ComponentType<any>>;
  /** Optional: actions dispatcher for {$action: ...} values. */
  actions?: FaceUiActions;
  /**
   * Optional custom ref resolver. Defaults to dot-path access into `context`.
   */
  resolveRef?: FaceUiRenderEnv['resolveRef'];
  /** Node identity policy (see FaceUiRenderEnv.nodeIdPolicy). */
  nodeIdPolicy?: FaceUiRenderEnv['nodeIdPolicy'];
  /** Maximum tree depth allowed during materialization/render (default: 64). */
  maxDepth?: FaceUiRenderEnv['maxDepth'];
};

function defaultResolveRef(ref: any, ctx: any): any {
  try {
    const parts = String(ref || '').split('.').filter(Boolean);
    let cur: any = ctx;
    for (const p of parts) cur = cur?.[p];
    return cur;
  } catch {
    return undefined;
  }
}

export function FaceUi(props: FaceUiProps): React.ReactElement | null {
  const { doc, props: uiProps, context, registry, components, actions, resolveRef, nodeIdPolicy, maxDepth } = props;

  const env = React.useMemo<FaceUiRenderEnv>(() => {
    const reg =
      registry ||
      createFaceUiRegistry(components || {});
    return {
      registry: reg,
      actions,
      context: { ...(context || {}), props: uiProps || {} },
      resolveRef: resolveRef || defaultResolveRef,
      nodeIdPolicy,
      maxDepth,
    };
  }, [registry, components, context, uiProps, actions, resolveRef, nodeIdPolicy, maxDepth]);

  return renderFaceUiToReact(doc, env) as any;
}
