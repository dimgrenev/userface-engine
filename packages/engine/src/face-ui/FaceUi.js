import React from 'react';
import { createFaceUiRegistry } from './registry';
import { renderFaceUiToReact } from './react';
function defaultResolveRef(ref, ctx) {
    try {
        const parts = String(ref || '').split('.').filter(Boolean);
        let cur = ctx;
        for (const p of parts)
            cur = cur === null || cur === void 0 ? void 0 : cur[p];
        return cur;
    }
    catch (_a) {
        return undefined;
    }
}
export function FaceUi(props) {
    const { doc, props: uiProps, context, registry, components, actions, resolveRef, nodeIdPolicy, maxDepth } = props;
    const env = React.useMemo(() => {
        const reg = registry ||
            createFaceUiRegistry(components || {});
        return {
            registry: reg,
            actions,
            context: Object.assign(Object.assign({}, (context || {})), { props: uiProps || {} }),
            resolveRef: resolveRef || defaultResolveRef,
            nodeIdPolicy,
            maxDepth,
        };
    }, [registry, components, context, uiProps, actions, resolveRef, nodeIdPolicy, maxDepth]);
    return renderFaceUiToReact(doc, env);
}
