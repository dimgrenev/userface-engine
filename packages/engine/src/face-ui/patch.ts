import type { FaceUiDoc, FaceUiNode, FaceUiValue } from './types';
import { FaceUiDocSchema } from './schema';

export type FaceUiNodePath = {
  /** Deterministic id computed by materializer. */
  nodeId: string;
  /** Optional: array index path for debugging/editor use. */
  indexPath: number[];
};

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

function cloneNode(node: FaceUiNode): FaceUiNode {
  return {
    type: node.type,
    key: node.key,
    props: node.props ? { ...(node.props as any) } : undefined,
    children: Array.isArray(node.children) ? [...node.children] : undefined,
  };
}

function mapChildren(
  node: FaceUiNode,
  fn: (child: FaceUiNode, childIndexAmongNodes: number, childIndexInArray: number) => FaceUiNode
): FaceUiNode {
  const raw = Array.isArray(node.children) ? node.children : [];
  if (raw.length === 0) return node;
  let nodeChildIdx = 0;
  const nextChildren = raw.map((c, i) => {
    if (c == null) return c as any;
    if (typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean') return c as any;
    const out = fn(c as any, nodeChildIdx, i);
    nodeChildIdx += 1;
    return out as any;
  });
  return { ...(node as any), children: nextChildren as any };
}

function findNodeById(root: FaceUiNode, nodeId: string): { node: FaceUiNode; parent: FaceUiNode | null; indexPath: number[] } | null {
  const target = String(nodeId || '').trim();
  if (!target) return null;

  const walk = (
    node: FaceUiNode,
    parent: FaceUiNode | null,
    parentId: string,
    siblingIndex: number,
    indexPath: number[],
    depth: number
  ): any => {
    const seg = segmentForNode(node, siblingIndex);
    const id = joinId(parentId, seg);
    if (id === target) return { node, parent, indexPath };
    const raw = Array.isArray(node.children) ? node.children : [];
    let nodeChildIdx = 0;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i] as any;
      if (ch == null) continue;
      if (typeof ch === 'string' || typeof ch === 'number' || typeof ch === 'boolean') continue;
      const res = walk(ch as FaceUiNode, node, id, nodeChildIdx, [...indexPath, nodeChildIdx], depth + 1);
      if (res) return res;
      nodeChildIdx += 1;
    }
    return null;
  };

  return walk(root, null, '', 0, [0], 1);
}

/** Get a node from `ui@1` doc by derived nodeId. */
export function getNode(doc: unknown, nodeId: string): FaceUiNode | null {
  const parsed = FaceUiDocSchema.parse(doc) as FaceUiDoc;
  const hit = findNodeById(parsed.root as any, nodeId);
  return hit ? (hit.node as any) : null;
}

/**
 * Set a prop on a node (immutable update), addressed by derived nodeId.
 * Returns a new doc object.
 */
export function setNodeProp(doc: unknown, nodeId: string, propName: string, value: FaceUiValue): FaceUiDoc {
  const parsed = FaceUiDocSchema.parse(doc) as FaceUiDoc;
  const target = String(nodeId || '').trim();
  const pName = String(propName || '').trim();
  if (!target || !pName) return parsed;

  const patch = (node: FaceUiNode, parentId: string, siblingIndex: number): FaceUiNode => {
    const seg = segmentForNode(node, siblingIndex);
    const id = joinId(parentId, seg);
    let next = node;
    if (id === target) {
      const cloned = cloneNode(node);
      cloned.props = { ...(cloned.props || {}), [pName]: value } as any;
      next = cloned;
    }
    // Recurse into node-children only (skip primitives)
    next = mapChildren(next, (child, childIdx) => patch(child, id, childIdx));
    return next;
  };

  const nextRoot = patch(parsed.root as any, '', 0);
  return { ...parsed, root: nextRoot };
}

/**
 * Unset a prop on a node (immutable update), addressed by derived nodeId.
 * Returns a new doc object.
 */
export function unsetNodeProp(doc: unknown, nodeId: string, propName: string): FaceUiDoc {
  const parsed = FaceUiDocSchema.parse(doc) as FaceUiDoc;
  const target = String(nodeId || '').trim();
  const pName = String(propName || '').trim();
  if (!target || !pName) return parsed;

  const patch = (node: FaceUiNode, parentId: string, siblingIndex: number): FaceUiNode => {
    const seg = segmentForNode(node, siblingIndex);
    const id = joinId(parentId, seg);
    let next = node;
    if (id === target) {
      const cloned = cloneNode(node);
      const props = { ...(cloned.props || {}) } as any;
      delete props[pName];
      cloned.props = props;
      next = cloned;
    }
    next = mapChildren(next, (child, childIdx) => patch(child, id, childIdx));
    return next;
  };

  const nextRoot = patch(parsed.root as any, '', 0);
  return { ...parsed, root: nextRoot };
}

// ── Tree operations ──────────────────────────────────────────

/**
 * Add a child node to a parent node identified by nodeId.
 * If index is provided, inserts at that position; otherwise appends.
 */
export function addChild(doc: unknown, parentNodeId: string, child: FaceUiNode, index?: number): FaceUiDoc {
  const parsed = FaceUiDocSchema.parse(doc) as FaceUiDoc;
  const target = String(parentNodeId || '').trim();
  if (!target || !child) return parsed;

  const patch = (node: FaceUiNode, parentId: string, siblingIndex: number): FaceUiNode => {
    const seg = segmentForNode(node, siblingIndex);
    const id = joinId(parentId, seg);
    let next = node;
    if (id === target) {
      const cloned = cloneNode(node);
      const children = Array.isArray(cloned.children) ? [...cloned.children] : [];
      if (index != null && index >= 0 && index <= children.length) {
        children.splice(index, 0, child as any);
      } else {
        children.push(child as any);
      }
      cloned.children = children as any;
      next = cloned;
    }
    next = mapChildren(next, (ch, childIdx) => patch(ch, id, childIdx));
    return next;
  };

  const nextRoot = patch(parsed.root as any, '', 0);
  return { ...parsed, root: nextRoot };
}

/**
 * Remove a node and all its descendants by nodeId.
 * Cannot remove the root node.
 */
export function removeNode(doc: unknown, nodeId: string): FaceUiDoc {
  const parsed = FaceUiDocSchema.parse(doc) as FaceUiDoc;
  const target = String(nodeId || '').trim();
  if (!target) return parsed;

  // Prevent removing root
  const rootSeg = segmentForNode(parsed.root as any, 0);
  if (rootSeg === target) throw new Error('Cannot remove root node');

  const patch = (node: FaceUiNode, parentId: string, siblingIndex: number): FaceUiNode => {
    const seg = segmentForNode(node, siblingIndex);
    const id = joinId(parentId, seg);
    // Filter out the target from children
    if (Array.isArray(node.children)) {
      let nodeChildIdx = 0;
      const filtered: any[] = [];
      for (const c of node.children) {
        if (c == null || typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean') {
          filtered.push(c);
          continue;
        }
        const childSeg = segmentForNode(c as any, nodeChildIdx);
        const childId = joinId(id, childSeg);
        if (childId !== target) {
          filtered.push(c);
        }
        nodeChildIdx += 1;
      }
      if (filtered.length !== node.children.length) {
        const cloned = cloneNode(node);
        cloned.children = filtered as any;
        return mapChildren(cloned, (ch, childIdx) => patch(ch, id, childIdx));
      }
    }
    return mapChildren(node, (ch, childIdx) => patch(ch, id, childIdx));
  };

  const nextRoot = patch(parsed.root as any, '', 0);
  return { ...parsed, root: nextRoot };
}

/**
 * Move a node to a new parent at optional index.
 * Cannot move root or move a node into its own descendant.
 */
export function moveNode(doc: unknown, nodeId: string, newParentId: string, index?: number): FaceUiDoc {
  const parsed = FaceUiDocSchema.parse(doc) as FaceUiDoc;
  const target = String(nodeId || '').trim();
  if (!target || !newParentId) return parsed;

  // Find the node first
  const found = findNodeById(parsed.root as any, target);
  if (!found) return parsed;

  // Remove from current position, then add to new parent
  const afterRemove = removeNode(parsed, target);
  return addChild(afterRemove, newParentId, found.node, index);
}

/**
 * Deep-clone a node and insert it as a sibling (after the original).
 * Cloned nodes get new keys to avoid nodeId collisions.
 */
export function duplicateNode(doc: unknown, nodeId: string): FaceUiDoc {
  const parsed = FaceUiDocSchema.parse(doc) as FaceUiDoc;
  const target = String(nodeId || '').trim();
  if (!target) return parsed;

  const found = findNodeById(parsed.root as any, target);
  if (!found || !found.parent) return parsed; // Can't duplicate root

  // Deep clone with new keys
  let keyCounter = 0;
  const deepClone = (node: FaceUiNode): FaceUiNode => {
    const cloned: FaceUiNode = {
      type: node.type,
      key: `dup${++keyCounter}`,
      props: node.props ? JSON.parse(JSON.stringify(node.props)) : undefined,
      children: Array.isArray(node.children)
        ? node.children.map(c => {
            if (c == null || typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean') return c;
            return deepClone(c as FaceUiNode);
          }) as any
        : undefined,
    };
    return cloned;
  };

  const clone = deepClone(found.node);

  // Find parent nodeId and insert after original
  const parentId = (() => {
    // Walk to find parent's nodeId
    const walk = (node: FaceUiNode, pId: string, si: number): string | null => {
      const seg = segmentForNode(node, si);
      const id = joinId(pId, seg);
      if (node === found.parent) return id;
      const raw = Array.isArray(node.children) ? node.children : [];
      let nci = 0;
      for (const c of raw) {
        if (c == null || typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean') continue;
        const r = walk(c as FaceUiNode, id, nci);
        if (r) return r;
        nci += 1;
      }
      return null;
    };
    return walk(parsed.root as any, '', 0) || '';
  })();

  // Insert after the original's position
  const insertIndex = found.indexPath[found.indexPath.length - 1] + 1;
  return addChild(parsed, parentId, clone, insertIndex);
}

/**
 * Wrap a node in a new parent of given type.
 * The original node becomes the sole child of the wrapper.
 */
export function wrapNode(doc: unknown, nodeId: string, wrapperType: string, wrapperProps?: Record<string, FaceUiValue>): FaceUiDoc {
  const parsed = FaceUiDocSchema.parse(doc) as FaceUiDoc;
  const target = String(nodeId || '').trim();
  if (!target || !wrapperType) return parsed;

  const patch = (node: FaceUiNode, parentId: string, siblingIndex: number): FaceUiNode => {
    const seg = segmentForNode(node, siblingIndex);
    const id = joinId(parentId, seg);

    // Check children for the target
    if (Array.isArray(node.children)) {
      let nodeChildIdx = 0;
      let modified = false;
      const nextChildren: any[] = [];
      for (const c of node.children) {
        if (c == null || typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean') {
          nextChildren.push(c);
          continue;
        }
        const childSeg = segmentForNode(c as any, nodeChildIdx);
        const childId = joinId(id, childSeg);
        if (childId === target) {
          // Replace child with wrapper containing child
          const wrapper: FaceUiNode = {
            type: wrapperType,
            props: wrapperProps as any,
            children: [c as any],
          };
          nextChildren.push(wrapper);
          modified = true;
        } else {
          nextChildren.push(c);
        }
        nodeChildIdx += 1;
      }
      if (modified) {
        const cloned = cloneNode(node);
        cloned.children = nextChildren as any;
        return mapChildren(cloned, (ch, childIdx) => patch(ch, id, childIdx));
      }
    }

    return mapChildren(node, (ch, childIdx) => patch(ch, id, childIdx));
  };

  // Special case: wrapping root
  const rootSeg = segmentForNode(parsed.root as any, 0);
  if (rootSeg === target) {
    const wrapper: FaceUiNode = {
      type: wrapperType,
      ...(wrapperProps ? { props: wrapperProps } : {}),
      children: [parsed.root as any],
    };
    return FaceUiDocSchema.parse({ ...parsed, root: wrapper }) as FaceUiDoc;
  }

  const nextRoot = patch(parsed.root as any, '', 0);
  return { ...parsed, root: nextRoot };
}
