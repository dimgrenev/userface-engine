import type {
  FaceUiDoc,
  FaceUiNode,
  FaceUiRenderEnv,
  FaceUiValue,
  FaceUiActionRef,
  FaceUiRef,
  MaterializedFaceUiNode,
  MaterializedFaceUiTree,
  MaterializedFaceUiChild,
} from './types';
import { FaceUiDocSchema } from './schema';

function isActionRef(v: any): v is FaceUiActionRef {
  return !!v && typeof v === 'object' && typeof v.$action === 'string';
}

function isRef(v: any): v is FaceUiRef {
  return !!v && typeof v === 'object' && typeof v.$ref === 'string';
}

function reviveValue(nodeType: string, propName: string, value: FaceUiValue, env: FaceUiRenderEnv): any {
  if (isActionRef(value)) {
    const actions = env.actions;
    if (!actions) return undefined;
    if (actions.allowlist && !actions.allowlist.includes(value.$action)) {
      console.warn(`[Face UI] Action "${value.$action}" is not in the allowlist. Dropping action binding.`);
      return undefined;
    }
    return () => actions.dispatch(value.$action, value.args, { nodeType, propName });
  }
  if (isRef(value)) {
    const resolveRef = env.resolveRef;
    if (!resolveRef) return undefined;
    return resolveRef(value.$ref, env.context);
  }
  return value;
}

function reviveProps(node: FaceUiNode, env: FaceUiRenderEnv): Record<string, any> {
  const raw = node.props || {};
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = reviveValue(node.type, k, v as any, env);
  const sanitize = env.registry.sanitizeProps;
  return sanitize ? sanitize(node.type, out) : out;
}

function segmentForNode(node: FaceUiNode, siblingIndex: number): string {
  const t = String(node.type || '').trim();
  const k = node.key != null ? String(node.key) : '';
  if (k) return `${t}:k${k}`;
  return `${t}:i${siblingIndex}`;
}

function joinId(parentId: string, seg: string): string {
  if (!parentId) return seg;
  return `${parentId}/${seg}`;
}

function ensureStableKey(node: FaceUiNode, parentId: string, siblingIndex: number, indexPath: number[]) {
  const t = String(node.type || '').trim();
  const k = node.key != null ? String(node.key) : '';
  if (k) return;
  const derivedId = joinId(parentId, segmentForNode(node, siblingIndex));
  const where = indexPath.length ? `path=${indexPath.join('.')}` : 'path=?';
  // Deterministic, grep-friendly error for clients.
  throw new Error(`UF_FACE_KEY_REQUIRED type=${t || 'unknown'} nodeId=${derivedId || '?'} ${where}`);
}

/**
 * Materialize a Face UI document into a canonical tree with deterministic nodeIds and resolved props.
 *
 * Contract (derived-only ids):
 * - nodeId is a path of segments joined by '/'
 * - segment is `${type}:k${key}` when key exists, otherwise `${type}:i${siblingIndex}`
 * - siblingIndex counts only node-children under the same parent in source order (0-based)
 * - duplicate nodeIds are rejected (deterministic error) to avoid silent byId overwrites
 */
export function materializeFaceUiDoc(doc: unknown, env: FaceUiRenderEnv): MaterializedFaceUiTree {
  const parsed = FaceUiDocSchema.parse(doc) as FaceUiDoc;
  const byId: Record<string, MaterializedFaceUiNode> = {};
  const seenNodeIds = new Set<string>();
  const nodeIdPolicy = (env && (env as any).nodeIdPolicy) ? String((env as any).nodeIdPolicy) : 'derived';
  const maxDepth = (() => {
    const raw = Number((env as any)?.maxDepth);
    if (Number.isFinite(raw) && raw > 0) return Math.max(1, Math.floor(raw));
    return 64;
  })();

  const walk = (
    node: FaceUiNode,
    parentId: string,
    siblingIndex: number,
    depth: number,
    indexPath: number[]
  ): MaterializedFaceUiNode => {
    if (depth > maxDepth) {
      const t = String(node.type || '').trim();
      throw new Error(`UF_FACE_MAX_DEPTH limit=${maxDepth} type=${t || 'unknown'} path=${indexPath.join('.')}`);
    }
    // Strict/stable ids: every non-root node must have a key.
    if (nodeIdPolicy === 'stable' && parentId) {
      ensureStableKey(node, parentId, siblingIndex, indexPath);
    }
    const seg = segmentForNode(node, siblingIndex);
    const nodeId = joinId(parentId, seg);
    const t = String(node.type || '').trim();
    if (seenNodeIds.has(nodeId)) {
      throw new Error(`UF_FACE_DUPLICATE_NODE_ID type=${t || 'unknown'} nodeId=${nodeId || '?'} path=${indexPath.join('.')}`);
    }
    seenNodeIds.add(nodeId);
    const rawProps = (node.props || {}) as Record<string, FaceUiValue>;
    const resolvedProps = reviveProps(node, env);
    const childrenRaw = Array.isArray(node.children) ? node.children : [];
    const children: MaterializedFaceUiChild[] = [];
    let nodeChildIdx = 0;
    for (let i = 0; i < childrenRaw.length; i++) {
      const ch = childrenRaw[i] as any;
      if (ch == null) continue;
      // Preserve primitives in-order (they do not have nodeId).
      if (typeof ch === 'string' || typeof ch === 'number' || typeof ch === 'boolean') {
        children.push(ch as any);
        continue;
      }
      // Node child: siblingIndex is among nodes only (matches patch.ts).
      const next = walk(ch as FaceUiNode, nodeId, nodeChildIdx, depth + 1, [...indexPath, nodeChildIdx]);
      children.push(next as any);
      nodeChildIdx += 1;
    }
    const out: MaterializedFaceUiNode = {
      nodeId,
      type: String(node.type || ''),
      key: node.key,
      rawProps,
      resolvedProps,
      children,
      parentId,
      depth,
    };
    byId[nodeId] = out;
    return out;
  };

  // Root siblingIndex is always 0 (root has no siblings).
  const root = walk(parsed.root as any, '', 0, 1, [0]);
  return { doc: parsed, root, byId };
}
