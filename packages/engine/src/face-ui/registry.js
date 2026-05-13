export function createFaceUiRegistry(components) {
    const map = Object.assign({}, (components || {}));
    return {
        resolve(type) {
            var _a;
            return (_a = map[type]) !== null && _a !== void 0 ? _a : null;
        },
    };
}
