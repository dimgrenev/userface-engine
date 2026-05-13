import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_COMPONENT_ROOTS = [
  'packages/face-ui-react',
  'src/components',
  'components',
];

function upperFirst(value) {
  const text = String(value || '');
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

function lowerFirst(value) {
  const text = String(value || '');
  return text ? text[0].toLowerCase() + text.slice(1) : '';
}

export function normalizeComponentName(value) {
  const text = String(value || '').trim();
  if (!text) {
    throw new Error('Component name is required');
  }

  const tokens = text
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/[^a-zA-Z0-9]/g, ''));

  if (tokens.length === 0) {
    throw new Error(`Could not derive a valid component name from "${value}"`);
  }

  const normalized = tokens.map((token) => upperFirst(token)).join('');
  if (!/^[A-Z][A-Za-z0-9]*$/.test(normalized)) {
    throw new Error(`Invalid component name "${value}". Use letters and numbers only.`);
  }
  return normalized;
}

export function toKebabCase(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function normalizeRelativePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function detectConfiguredComponentsRoot(cwd) {
  const configPath = path.join(cwd, 'userface.config.json');
  if (!fs.existsSync(configPath)) return '';
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return normalizeRelativePath(parsed.componentsDir || parsed.root || '');
  } catch {
    return '';
  }
}

export function detectComponentsRoot(cwd, explicitRoot = '') {
  const normalizedExplicit = normalizeRelativePath(explicitRoot);
  if (normalizedExplicit) return normalizedExplicit;

  const configured = detectConfiguredComponentsRoot(cwd);
  if (configured) return configured;

  for (const candidate of DEFAULT_COMPONENT_ROOTS) {
    const absoluteCandidate = path.join(cwd, candidate);
    if (fs.existsSync(absoluteCandidate)) return normalizeRelativePath(candidate);
  }

  return normalizeRelativePath(DEFAULT_COMPONENT_ROOTS[0]);
}

function componentTsxTemplate(name) {
  const anatomyName = `${lowerFirst(name)}Anatomy`;
  const displayName = toKebabCase(name);
  return `/**
 * ${name} — generated Userface component scaffold.
 *
 * Provides a safe starting point with anatomy, content slots, and a matching face.json contract.
 */

import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { createAnatomy } from '../assets/anatomy'
import { cn } from '../assets/utils'
import { Text } from '../Text/Text'

export const ${anatomyName} = createAnatomy('${displayName}').parts(
  'root', 'header', 'title', 'description', 'content', 'footer',
)

export interface ${name}Props extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'content' | 'children'> {
  title?: ReactNode
  description?: ReactNode
  content?: ReactNode
  footer?: ReactNode
  membrane?: boolean
  children?: ReactNode
}

function render${name}Node(node: ReactNode, variant: 'body' | 'muted' = 'body'): ReactNode {
  if (node == null) return null
  if (typeof node === 'string' || typeof node === 'number') {
    return (
      <Text as="div" variant={variant} membrane={false} inset="none">
        {String(node)}
      </Text>
    )
  }
  return node
}

export const ${name} = forwardRef<HTMLDivElement, ${name}Props>(
  function ${name}(props, ref) {
    const {
      title,
      description,
      content,
      footer,
      membrane = true,
      children,
      className,
      ...rest
    } = props

    const body = content ?? children

    return (
      <div
        ref={ref}
        {...${anatomyName}.getPartAttrs('root')}
        data-membrane={membrane ? '' : undefined}
        className={cn('uf-card', className)}
        {...rest}
      >
        {(title || description) && (
          <div {...${anatomyName}.getPartAttrs('header')}>
            {title && (
              <Text as="div" membrane={false} inset="none" {...${anatomyName}.getPartAttrs('title')}>
                {title}
              </Text>
            )}
            {description && (
              <Text as="div" variant="muted" membrane={false} inset="none" {...${anatomyName}.getPartAttrs('description')}>
                {description}
              </Text>
            )}
          </div>
        )}
        {body != null && (
          <div {...${anatomyName}.getPartAttrs('content')}>
            {render${name}Node(body)}
          </div>
        )}
        {footer != null && (
          <div {...${anatomyName}.getPartAttrs('footer')}>
            {render${name}Node(footer)}
          </div>
        )}
      </div>
    )
  },
)
`;
}

function componentFaceJsonTemplate(name) {
  return {
    name,
    description: `Generated Userface component scaffold for ${name}`,
    props: {
      title: {
        type: 'string',
        required: false,
        description: `${name} title`,
        default: `${name} Title`,
      },
      description: {
        type: 'string',
        required: false,
        description: `${name} description below the title`,
        default: `Describe the purpose of this ${name}.`,
      },
      content: {
        type: 'string',
        required: false,
        description: `${name} body content`,
        default: null,
      },
      footer: {
        type: 'string',
        required: false,
        description: `${name} footer content`,
        default: null,
      },
      membrane: {
        type: 'boolean',
        required: false,
        description: 'Membrane spacing',
        default: true,
      },
      children: {
        type: 'string',
        required: false,
        description: 'Custom children',
        default: null,
      },
    },
    states: [
      {
        name: 'Default',
        props: {
          title: `${name} Title`,
          description: `Describe the purpose of this ${name}.`,
        },
      },
      {
        name: 'With Content',
        props: {
          title: `${name} Title`,
          content: `${name} content goes here.`,
        },
      },
      {
        name: 'Full',
        props: {
          title: `${name} Title`,
          description: `Describe the purpose of this ${name}.`,
          content: `${name} content goes here.`,
          footer: `${name} footer`,
        },
      },
    ],
    behavior: {},
    keyboard: {},
    aria: {
      role: 'region',
    },
    composition: {
      required: ['root'],
      recommended: ['header', 'title', 'description', 'content', 'footer'],
      parts: {
        root: { slot: 'root' },
        header: { slot: 'header', parent: 'root' },
        title: { slot: 'title', parent: 'header' },
        description: { slot: 'description', parent: 'header' },
        content: { slot: 'content', parent: 'root' },
        footer: { slot: 'footer', parent: 'root' },
      },
    },
    platform: {},
    usage: {
      whenToUse: [
        'Scaffolding a new component quickly',
        'Starting a design-system building block with a documented contract',
        'Creating a content container before custom behavior is added',
      ],
      whenNotToUse: [
        'Replacing a mature, domain-specific component that already exists',
        'Shipping final interaction design without revisiting the generated scaffold',
      ],
      alternatives: ['Card', 'Panel'],
      context: 'both',
    },
  };
}

export function ensureBarrelExport(indexSource, name) {
  const current = String(indexSource || '');
  const exportLine = `export { ${name}, ${lowerFirst(name)}Anatomy } from './${name}/${name}'`;
  const typeLine = `export type { ${name}Props } from './${name}/${name}'`;
  if (current.includes(exportLine) || current.includes(`./${name}/${name}`)) {
    return current;
  }

  const next = current.trimEnd();
  const divider = next ? '\n\n' : '';
  const sectionHeader = next.includes('// Generated components') ? '' : '// Generated components\n';
  return `${next}${divider}${sectionHeader}${exportLine}\n${typeLine}\n`;
}

export function buildGeneratedComponentFiles(args) {
  const cwd = args.cwd || process.cwd();
  const name = normalizeComponentName(args.name);
  const componentsRoot = detectComponentsRoot(cwd, args.root);
  const componentDir = `${componentsRoot}/${name}`;
  const indexPath = `${componentsRoot}/index.ts`;
  const existingIndex = args.indexSource != null
    ? String(args.indexSource)
    : fs.existsSync(path.join(cwd, indexPath))
      ? fs.readFileSync(path.join(cwd, indexPath), 'utf-8')
      : '';

  return {
    name,
    componentsRoot,
    componentDir,
    files: [
      {
        path: `${componentDir}/${name}.tsx`,
        content: componentTsxTemplate(name),
      },
      {
        path: `${componentDir}/${name}.json`,
        content: JSON.stringify(componentFaceJsonTemplate(name), null, 2) + '\n',
      },
      {
        path: indexPath,
        content: ensureBarrelExport(existingIndex, name),
      },
    ],
  };
}

export function generateComponentScaffold(args) {
  const cwd = args.cwd || process.cwd();
  const scaffold = buildGeneratedComponentFiles(args);
  const absoluteComponentDir = path.join(cwd, scaffold.componentDir);
  if (fs.existsSync(absoluteComponentDir) && !args.overwrite) {
    throw new Error(`Component "${scaffold.name}" already exists at ${scaffold.componentDir}`);
  }

  fs.mkdirSync(absoluteComponentDir, { recursive: true });
  for (const file of scaffold.files) {
    const absolutePath = path.join(cwd, file.path);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, file.content, 'utf-8');
  }

  return {
    ...scaffold,
    created: true,
  };
}
