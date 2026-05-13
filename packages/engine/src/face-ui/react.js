import React from 'react';
import { materializeFaceUiDoc } from './materialize';
function isMaterializedNode(v) {
    return !!v && typeof v === 'object' && typeof v.nodeId === 'string' && typeof v.type === 'string' && Array.isArray(v.children);
}
function toReactChild(child, env, depth) {
    if (child === null || child === undefined)
        return null;
    if (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean')
        return child;
    if (isMaterializedNode(child))
        return renderMaterializedNode(child, env, depth);
    return null;
}
function renderMaterializedNode(node, env, depth) {
    var _a;
    const maxDepth = (_a = env.maxDepth) !== null && _a !== void 0 ? _a : 64;
    if (depth > maxDepth) {
        return React.createElement('div', null, `UF_FACE_DEPTH_LIMIT(${maxDepth})`);
    }
    const Comp = env.registry.resolve(node.type);
    if (!Comp) {
        return React.createElement('div', null, `UF_FACE_UNKNOWN_COMPONENT(${node.type})`);
    }
    const props = Object.assign({}, (node.resolvedProps || {}));
    if (node.key)
        props.key = node.key;
    const children = (node.children || []).map((c) => toReactChild(c, env, depth + 1));
    const inner = React.createElement(Comp, props, ...(children.length ? children : []));
    // Always attach stable node identity to DOM without depending on component prop-forwarding.
    // `display: contents` ensures the wrapper does not affect layout in modern browsers.
    return React.createElement('span', { 'data-uf-nodeid': node.nodeId, style: { display: 'contents' } }, inner);
}
/**
 * Render Face UI document to React element.
 * This is the core entrypoint for using face.json as a UI spec in real apps.
 */
export function renderFaceUiToReact(doc, env) {
    const tree = materializeFaceUiDoc(doc, env);
    return renderMaterializedNode(tree.root, env, 1);
}
