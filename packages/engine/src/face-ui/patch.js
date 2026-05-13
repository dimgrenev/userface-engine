import { FaceUiDocSchema } from './schema';
function segmentForNode(node, siblingIndex) {
    const t = String(node.type || '').trim();
    const k = node.key != null ? String(node.key) : '';
    if (k)
        return `${t}:k${k}`;
    return `${t}:i${siblingIndex}`;
}
function joinId(parentId, seg) {
    if (!parentId)
        return seg;
    return `${parentId}/${seg}`;
}
function cloneNode(node) {
    return {
        type: node.type,
        key: node.key,
        props: node.props ? Object.assign({}, node.props) : undefined,
        children: Array.isArray(node.children) ? [...node.children] : undefined,
    };
}
function mapChildren(node, fn) {
    const raw = Array.isArray(node.children) ? node.children : [];
    if (raw.length === 0)
        return node;
    let nodeChildIdx = 0;
    const nextChildren = raw.map((c, i) => {
        if (c == null)
            return c;
        if (typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean')
            return c;
        const out = fn(c, nodeChildIdx, i);
        nodeChildIdx += 1;
        return out;
    });
    return Object.assign(Object.assign({}, node), { children: nextChildren });
}
function findNodeById(root, nodeId) {
    const target = String(nodeId || '').trim();
    if (!target)
        return null;
    const walk = (node, parent, parentId, siblingIndex, indexPath, depth) => {
        const seg = segmentForNode(node, siblingIndex);
        const id = joinId(parentId, seg);
        if (id === target)
            return { node, parent, indexPath };
        const raw = Array.isArray(node.children) ? node.children : [];
        let nodeChildIdx = 0;
        for (let i = 0; i < raw.length; i++) {
            const ch = raw[i];
            if (ch == null)
                continue;
            if (typeof ch === 'string' || typeof ch === 'number' || typeof ch === 'boolean')
                continue;
            const res = walk(ch, node, id, nodeChildIdx, [...indexPath, nodeChildIdx], depth + 1);
            if (res)
                return res;
            nodeChildIdx += 1;
        }
        return null;
    };
    return walk(root, null, '', 0, [0], 1);
}
/** Get a node from `ui@1` doc by derived nodeId. */
export function getNode(doc, nodeId) {
    const parsed = FaceUiDocSchema.parse(doc);
    const hit = findNodeById(parsed.root, nodeId);
    return hit ? hit.node : null;
}
/**
 * Set a prop on a node (immutable update), addressed by derived nodeId.
 * Returns a new doc object.
 */
export function setNodeProp(doc, nodeId, propName, value) {
    const parsed = FaceUiDocSchema.parse(doc);
    const target = String(nodeId || '').trim();
    const pName = String(propName || '').trim();
    if (!target || !pName)
        return parsed;
    const patch = (node, parentId, siblingIndex) => {
        const seg = segmentForNode(node, siblingIndex);
        const id = joinId(parentId, seg);
        let next = node;
        if (id === target) {
            const cloned = cloneNode(node);
            cloned.props = Object.assign(Object.assign({}, (cloned.props || {})), { [pName]: value });
            next = cloned;
        }
        // Recurse into node-children only (skip primitives)
        next = mapChildren(next, (child, childIdx) => patch(child, id, childIdx));
        return next;
    };
    const nextRoot = patch(parsed.root, '', 0);
    return Object.assign(Object.assign({}, parsed), { root: nextRoot });
}
/**
 * Unset a prop on a node (immutable update), addressed by derived nodeId.
 * Returns a new doc object.
 */
export function unsetNodeProp(doc, nodeId, propName) {
    const parsed = FaceUiDocSchema.parse(doc);
    const target = String(nodeId || '').trim();
    const pName = String(propName || '').trim();
    if (!target || !pName)
        return parsed;
    const patch = (node, parentId, siblingIndex) => {
        const seg = segmentForNode(node, siblingIndex);
        const id = joinId(parentId, seg);
        let next = node;
        if (id === target) {
            const cloned = cloneNode(node);
            const props = Object.assign({}, (cloned.props || {}));
            delete props[pName];
            cloned.props = props;
            next = cloned;
        }
        next = mapChildren(next, (child, childIdx) => patch(child, id, childIdx));
        return next;
    };
    const nextRoot = patch(parsed.root, '', 0);
    return Object.assign(Object.assign({}, parsed), { root: nextRoot });
}
