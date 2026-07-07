import type { FaceUiDoc, FaceUiNode, FaceUiRenderEnv } from './types';
import { FaceUiDocSchema } from './schema';

export type FaceUiValidationIssue = {
  code: 'UF_FACE_KEY_REQUIRED' | 'UF_FACE_INVALID_DOC' | 'UF_FACE_MAX_DEPTH' | 'UF_FACE_DUPLICATE_NODE_ID';
  message: string;
  nodeId: string;
  type: string;
  indexPath: number[];
};

function segmentForNode(node: FaceUiNode, siblingIndexAmongNodes: number): string {
  const t = String(node.type || '').trim();
  const k = node.key != null ? String(node.key) : '';
  if (k) return `${t}:k${k}`;
  return `${t}:i${siblingIndexAmongNodes}`;
}

function joinId(parentId: string, seg: string): string {
  if (!parentId) return seg;
  return `${parentId}/${seg}`;
}

/**
 * Validate a face schema v1 doc for a given identity policy.
 *
 * Current checks:
 * - `nodeIdPolicy: 'stable'`: every non-root node must define `key`.
 * - `maxDepth` guard: reject trees deeper than allowed (default 64).
 * - duplicate derived `nodeId` detection (typically same `type+key` under one parent).
 *
 * Returns a full list of issues (CI-friendly), never throws.
 */
export function validateFaceUiDoc(doc: unknown, env?: Pick<FaceUiRenderEnv, 'nodeIdPolicy' | 'maxDepth'>): FaceUiValidationIssue[] {
  const issues: FaceUiValidationIssue[] = [];
  let parsed: FaceUiDoc;
  try {
    parsed = FaceUiDocSchema.parse(doc) as FaceUiDoc;
  } catch (e: any) {
    // Schema errors are not part of this validator's contract; surface as a single issue.
    const msg = String(e?.message || e || 'Invalid face doc');
    issues.push({
      code: 'UF_FACE_INVALID_DOC',
      message: `UF_FACE_INVALID_DOC ${msg}`,
      nodeId: '',
      type: '',
      indexPath: [],
    });
    return issues;
  }

  const policy = env?.nodeIdPolicy || 'derived';
  const maxDepth = (() => {
    const raw = Number((env as any)?.maxDepth);
    if (Number.isFinite(raw) && raw > 0) return Math.max(1, Math.floor(raw));
    return 64;
  })();
  const requireStableKeys = policy === 'stable';
  const seenNodeIds = new Set<string>();

  const walk = (node: FaceUiNode, parentId: string, indexPath: number[], depth: number) => {
    const isRoot = !parentId;
    // sibling index among nodes is computed at the parent loop; for root it's always 0.
    const nodeId = (() => {
      const siblingIndex = indexPath.length ? indexPath[indexPath.length - 1] : 0;
      return joinId(parentId, segmentForNode(node, siblingIndex));
    })();
    const t = String(node.type || '').trim();

    if (seenNodeIds.has(nodeId)) {
      const msg = `UF_FACE_DUPLICATE_NODE_ID type=${t || 'unknown'} nodeId=${nodeId || '?'} path=${indexPath.join('.')}`;
      issues.push({
        code: 'UF_FACE_DUPLICATE_NODE_ID',
        message: msg,
        nodeId: nodeId || '',
        type: t,
        indexPath,
      });
    } else {
      seenNodeIds.add(nodeId);
    }

    if (depth > maxDepth) {
      const msg = `UF_FACE_MAX_DEPTH limit=${maxDepth} type=${t || 'unknown'} nodeId=${nodeId || '?'} path=${indexPath.join('.')}`;
      issues.push({
        code: 'UF_FACE_MAX_DEPTH',
        message: msg,
        nodeId: nodeId || '',
        type: t,
        indexPath,
      });
      return;
    }

    if (requireStableKeys && !isRoot) {
      const k = node.key != null ? String(node.key) : '';
      if (!k) {
        const msg = `UF_FACE_KEY_REQUIRED type=${t || 'unknown'} nodeId=${nodeId || '?'} path=${indexPath.join('.')}`;
        issues.push({
          code: 'UF_FACE_KEY_REQUIRED',
          message: msg,
          nodeId: nodeId || '',
          type: t,
          indexPath,
        });
      }
    }

    const raw = Array.isArray(node.children) ? node.children : [];
    let nodeChildIdx = 0;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i] as any;
      if (ch == null) continue;
      if (typeof ch === 'string' || typeof ch === 'number' || typeof ch === 'boolean') continue;
      const childIndexPath = [...indexPath, nodeChildIdx];
      // recurse with the computed parentId (nodeId) – identity uses nodeId chain
      walk(ch as FaceUiNode, nodeId, childIndexPath, depth + 1);
      nodeChildIdx += 1;
    }
  };

  // Root indexPath [0] by convention; it doesn't need key.
  walk(parsed.root as any, '', [0], 1);
  return issues;
}
