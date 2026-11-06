import React from 'react';
import type {
  FaceUiRenderEnv,
} from './types';
import type { MaterializedFaceUiChild, MaterializedFaceUiNode } from './types';
import { materializeFaceUiDoc } from './materialize';

export type FaceUiReactRenderOptions = {
  /** Observe only the DOM wrappers created by this renderer for Face nodes. */
  onNodeElement?: (element: HTMLElement | null, identity: Readonly<{ nodeId: string; type: string }>) => void;
};

function isMaterializedNode(v: any): v is MaterializedFaceUiNode {
  return !!v && typeof v === 'object' && typeof v.nodeId === 'string' && typeof v.type === 'string' && Array.isArray(v.children);
}

function toReactChild(child: MaterializedFaceUiChild, env: FaceUiRenderEnv, depth: number, options?: FaceUiReactRenderOptions): any {
  if (child === null || child === undefined) return null;
  if (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean') return child;
  if (isMaterializedNode(child)) return renderMaterializedNode(child, env, depth, options);
  return null;
}

function renderMaterializedNode(node: MaterializedFaceUiNode, env: FaceUiRenderEnv, depth: number, options?: FaceUiReactRenderOptions): React.ReactElement {
  const maxDepth = env.maxDepth ?? 64;
  if (depth > maxDepth) {
    return React.createElement('div', null, `UF_FACE_DEPTH_LIMIT(${maxDepth})`);
  }

  const Comp = env.registry.resolve(node.type);
  if (!Comp) {
    return React.createElement('div', null, `UF_FACE_UNKNOWN_COMPONENT(${node.type})`);
  }

  const props = { ...(node.resolvedProps || {}) } as any;
  if (node.key) props.key = node.key;

  const children = (node.children || []).map((c) => toReactChild(c as any, env, depth + 1, options));
  const inner = React.createElement(Comp, props, ...(children.length ? children : []));
  const onNodeElement = options?.onNodeElement;
  const identity = onNodeElement ? Object.freeze({ nodeId: node.nodeId, type: node.type }) : undefined;
  // Always attach stable node identity to DOM without depending on component prop-forwarding.
  // `display: contents` ensures the wrapper does not affect layout in modern browsers.
  return React.createElement(
    'span',
    {
      key: node.nodeId,
      'data-uf-nodeid': node.nodeId,
      style: { display: 'contents' } as any,
      ...(onNodeElement ? { ref: (element: HTMLSpanElement | null) => onNodeElement(element, identity!) } : {}),
    },
    inner
  );
}

/**
 * Render Face UI document to React element.
 * This is the core entrypoint for using face.json as a UI spec in real apps.
 */
export function renderFaceUiToReact(doc: unknown, env: FaceUiRenderEnv, options?: FaceUiReactRenderOptions): React.ReactElement {
  const tree = materializeFaceUiDoc(doc, env);
  return renderMaterializedNode(tree.root as any, env, 1, options);
}
