/**
 * Shared prop-parsing helpers used by CoreEngine and PropExtractor.
 * Single source of truth for regex-based type mapping and union parsing.
 */
// ---------------------------------------------------------------------------
// String-literal union parsing
// ---------------------------------------------------------------------------
/**
 * Extract string literal values from a union type.
 * e.g. "'default' | 'accent' | 'outline'" → ['default', 'accent', 'outline']
 */
export function parseStringLiterals(rawType) {
    const raw = (rawType || '').trim();
    if (!raw.includes("'") && !raw.includes('"'))
        return [];
    const parts = raw.split('|').map(p => p.trim()).filter(p => p && p !== 'undefined');
    const literals = [];
    for (const p of parts) {
        const m = /^'([^']*)'$/.exec(p) || /^"([^"]*)"$/.exec(p);
        if (m)
            literals.push(m[1]);
    }
    return (literals.length > 0 && literals.length === parts.length) ? literals : [];
}
// ---------------------------------------------------------------------------
// Local type alias extraction
// ---------------------------------------------------------------------------
/**
 * Extract local type aliases that resolve to string-literal unions.
 * e.g. "type ButtonVariant = 'default' | 'accent';" → { ButtonVariant: ['default', 'accent'] }
 */
export function extractLocalAliases(code) {
    const aliases = {};
    const re = /type\s+([A-Z][A-Za-z0-9_]*)\s*=\s*([^;{]+)/g;
    let m;
    while ((m = re.exec(code)) !== null) {
        const name = m[1];
        const rhs = m[2].trim();
        const literals = parseStringLiterals(rhs);
        if (literals.length > 0) {
            aliases[name] = literals;
        }
    }
    return aliases;
}
// ---------------------------------------------------------------------------
// Rich type mapping
// ---------------------------------------------------------------------------
const TYPE_MAP = {
    'string': 'string',
    'number': 'number',
    'boolean': 'boolean',
    'any': 'any',
    'unknown': 'any',
    'void': 'any',
    'null': 'any',
    'undefined': 'any',
    'React.ReactNode': 'node',
    'React.ReactElement': 'node',
    'JSX.Element': 'node',
};
/**
 * Map a TypeScript type string to a simplified type + options.
 * Detects string-literal unions and local type aliases.
 */
export function mapTypeRich(tsType, aliases) {
    const raw = (tsType || '').trim();
    if (!raw)
        return { type: 'any' };
    // Local type alias (e.g. ButtonVariant → ['default', 'accent'])
    if (aliases && aliases[raw])
        return { type: 'select', options: aliases[raw] };
    // Inline string-literal union
    const literals = parseStringLiterals(raw);
    if (literals.length > 0)
        return { type: 'select', options: literals };
    // Direct type map
    if (TYPE_MAP[raw])
        return { type: TYPE_MAP[raw] };
    // Fuzzy matching for common patterns
    if (/\bstring\b/.test(raw))
        return { type: 'string' };
    if (/\bnumber\b/.test(raw))
        return { type: 'number' };
    if (/\bboolean\b/.test(raw))
        return { type: 'boolean' };
    if (/\bReactNode\b|\bJSX\.Element\b/.test(raw))
        return { type: 'node' };
    if (/\[\]$/.test(raw) || /\bArray</.test(raw))
        return { type: 'array' };
    if (/^\{/.test(raw))
        return { type: 'object' };
    // Preserve named type references (e.g. IconName, CustomType)
    if (/^[A-Z][A-Za-z0-9_]*$/.test(raw))
        return { type: raw };
    return { type: 'any' };
}
// ---------------------------------------------------------------------------
// Brace block extraction
// ---------------------------------------------------------------------------
/**
 * Extract a balanced { ... } block starting at braceStart position.
 */
export function extractBraceBlock(code, braceStart) {
    if (braceStart < 0)
        return null;
    let depth = 0;
    let start = -1;
    for (let i = braceStart; i < code.length; i++) {
        const ch = code[i];
        if (ch === '{') {
            depth++;
            if (depth === 1)
                start = i + 1;
        }
        else if (ch === '}') {
            depth--;
            if (depth === 0 && start >= 0) {
                return { body: code.slice(start, i), end: i + 1 };
            }
        }
    }
    return null;
}
/**
 * Split interface/type body into prop-like lines, respecting nested braces.
 */
export function splitInterfaceBody(body) {
    const parts = [];
    let current = '';
    let depth = 0;
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch === '{')
            depth++;
        if (ch === '}')
            depth--;
        if (depth === 0 && (ch === ';' || ch === '\n')) {
            if (current.trim())
                parts.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim())
        parts.push(current.trim());
    return parts;
}
// ---------------------------------------------------------------------------
// Enum extraction
// ---------------------------------------------------------------------------
/**
 * Extract TypeScript enum definitions from source code.
 */
export function extractEnumMap(code) {
    var _a;
    const enumMap = {};
    const enumRegex = /enum\s+(\w+)\s*\{([\s\S]*?)\}/g;
    let match;
    while ((match = enumRegex.exec(code)) !== null) {
        const enumName = match[1];
        const body = match[2];
        const values = [];
        const entryRegex = /(\w+)\s*(=\s*([^,\n]+))?/g;
        let em;
        while ((em = entryRegex.exec(body)) !== null) {
            const rhs = (_a = em[3]) === null || _a === void 0 ? void 0 : _a.trim();
            if (rhs) {
                const stringMatch = rhs.match(/^[\'\"]([^\'\"]+)[\'\"]/);
                if (stringMatch) {
                    values.push(stringMatch[1]);
                }
                else {
                    values.push(em[1]);
                }
            }
            else {
                values.push(em[1]);
            }
        }
        enumMap[enumName] = values;
    }
    return enumMap;
}
// ---------------------------------------------------------------------------
// Inline object type parsing
// ---------------------------------------------------------------------------
/**
 * Parse an inline object type like `{ label: string; count?: number }` into ComponentProp[].
 */
export function parseInlineObjectType(objectType, aliases) {
    const fields = [];
    const content = objectType.slice(1, -1).trim();
    if (!content)
        return fields;
    const propRegex = /(\w+)(\??):\s*([^;]+?)(?=;|\n\s*\w+\s*:|$)/g;
    let propMatch;
    while ((propMatch = propRegex.exec(content)) !== null) {
        const propName = propMatch[1];
        const isOptional = !!propMatch[2];
        let rawType = propMatch[3].trim().replace(/;\s*$/, '').trim();
        if (rawType.startsWith('{') && rawType.includes('}')) {
            const nestedFields = parseInlineObjectType(rawType, aliases);
            fields.push({ name: propName, type: 'object', required: !isOptional, description: `${propName} field`, fields: nestedFields });
        }
        else {
            const mapped = mapTypeRich(rawType, aliases);
            const prop = { name: propName, type: mapped.type, required: !isOptional, description: `${propName} field` };
            if (mapped.options)
                prop.options = mapped.options;
            fields.push(prop);
        }
    }
    return fields;
}
// ---------------------------------------------------------------------------
// Interface map extraction
// ---------------------------------------------------------------------------
/**
 * Build a map of all interfaces in the source to their parsed fields.
 */
export function extractInterfaceMap(code, aliases) {
    const interfaceMap = {};
    const enumMap = extractEnumMap(code);
    const resolvedAliases = aliases !== null && aliases !== void 0 ? aliases : extractLocalAliases(code);
    const interfaceRegex = /interface\s+(\w+)\s*\{/g;
    let match;
    while ((match = interfaceRegex.exec(code)) !== null) {
        const interfaceName = match[1];
        const startIndex = match.index + match[0].length;
        let braceCount = 1;
        let endIndex = startIndex;
        while (braceCount > 0 && endIndex < code.length) {
            if (code[endIndex] === '{')
                braceCount++;
            else if (code[endIndex] === '}')
                braceCount--;
            endIndex++;
        }
        if (braceCount === 0) {
            const interfaceBody = code.slice(startIndex, endIndex - 1);
            interfaceMap[interfaceName] = parseInterfaceBodyRaw(interfaceBody, enumMap, interfaceMap, resolvedAliases);
        }
    }
    return interfaceMap;
}
/**
 * Parse the raw body of a TypeScript interface into ComponentProp[].
 */
function parseInterfaceBodyRaw(body, enumMap, interfaceMap, aliases) {
    const props = [];
    const propRegex = /(\w+)(\??):\s*([^;]+?)(?=;|\n\s*\w+\s*:|$)/g;
    let propMatch;
    while ((propMatch = propRegex.exec(body)) !== null) {
        const propName = propMatch[1];
        const isOptional = !!propMatch[2];
        let rawType = propMatch[3].trim().replace(/;\s*$/, '').trim();
        if (enumMap[rawType]) {
            props.push({ name: propName, type: 'enum', required: !isOptional, description: `${propName} field`, enumValues: enumMap[rawType] });
        }
        else if (aliases && aliases[rawType]) {
            props.push({ name: propName, type: 'select', required: !isOptional, description: `${propName} field`, options: aliases[rawType] });
        }
        else if (interfaceMap[rawType]) {
            props.push({ name: propName, type: 'object', required: !isOptional, description: `${propName} field`, fields: interfaceMap[rawType] });
        }
        else if (rawType.startsWith('{') && rawType.includes('}')) {
            props.push({ name: propName, type: 'object', required: !isOptional, description: `${propName} field`, fields: parseInlineObjectType(rawType, aliases) });
        }
        else {
            const mapped = mapTypeRich(rawType, aliases);
            const prop = { name: propName, type: mapped.type, required: !isOptional, description: `${propName} field` };
            if (mapped.options)
                prop.options = mapped.options;
            props.push(prop);
        }
    }
    return props;
}
// ---------------------------------------------------------------------------
// Consolidated prop extraction from TypeScript source
// ---------------------------------------------------------------------------
/**
 * Extract React component props from TypeScript source code using regex.
 * This is the canonical, consolidated extraction function.
 * Replaces the duplicated extractPropsWithRegex in CoreEngine.
 */
export function extractPropsFromCode(code) {
    const props = [];
    const enumMap = extractEnumMap(code);
    const aliases = extractLocalAliases(code);
    const interfaceMap = extractInterfaceMap(code, aliases);
    const interfaceRegex = /interface\s+(\w+)(?:\s+extends[^{]+)?\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
    let match;
    while ((match = interfaceRegex.exec(code)) !== null) {
        const interfaceName = match[1];
        const interfaceBody = match[2];
        if (!interfaceName.includes('Props'))
            continue;
        const lines = interfaceBody.split('\n');
        let i = 0;
        while (i < lines.length) {
            const line = lines[i].trim();
            if (!line || line.startsWith('//') || line.startsWith('/*')) {
                i++;
                continue;
            }
            const propMatch = line.match(/(\w+)(\??):\s*(.*)/);
            if (propMatch) {
                const propName = propMatch[1];
                const isOptional = propMatch[2];
                let rawType = propMatch[3];
                // Collect multi-line object types
                if (rawType.trim().startsWith('{')) {
                    let braceCount = 0;
                    let fullType = '';
                    let j = i;
                    while (j < lines.length) {
                        const currentLine = lines[j].trim();
                        fullType += currentLine + '\n';
                        for (const char of currentLine) {
                            if (char === '{')
                                braceCount++;
                            if (char === '}')
                                braceCount--;
                        }
                        if (braceCount === 0 && fullType.includes('}'))
                            break;
                        j++;
                    }
                    const objectTypeMatch = fullType.match(/\{[^}]*\}/);
                    rawType = objectTypeMatch ? objectTypeMatch[0] : fullType.replace(/;\s*$/, '').trim();
                    i = j + 1;
                }
                else {
                    rawType = rawType.replace(/;\s*$/, '').trim();
                    i++;
                }
                if (enumMap[rawType]) {
                    props.push({ name: propName, type: 'enum', required: !isOptional, description: `${propName} prop`, enumValues: enumMap[rawType] });
                }
                else if (interfaceMap[rawType]) {
                    props.push({ name: propName, type: 'object', required: !isOptional, description: `${propName} prop`, fields: interfaceMap[rawType] });
                }
                else if (rawType.startsWith('{') && rawType.includes('}')) {
                    props.push({ name: propName, type: 'object', required: !isOptional, description: `${propName} prop`, fields: parseInlineObjectType(rawType, aliases) });
                }
                else if (aliases[rawType]) {
                    props.push({ name: propName, type: 'select', required: !isOptional, description: `${propName} prop`, options: aliases[rawType] });
                }
                else {
                    const mapped = mapTypeRich(rawType, aliases);
                    const prop = { name: propName, type: mapped.type, required: !isOptional, description: `${propName} prop` };
                    if (mapped.options)
                        prop.options = mapped.options;
                    props.push(prop);
                }
            }
            else {
                i++;
            }
        }
    }
    return props;
}
