import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearRegistryCache, scanRegistry } from '../registry.ts';

vi.mock('../fs-helpers', async () => import('../fs-helpers.ts'));
vi.mock('../propParsingHelpers', async () => import('../propParsingHelpers.ts'));

const tempRoots: string[] = [];

function makeTempRegistry(): string {
  const root = mkdtempSync(join(tmpdir(), 'userface-registry-'));
  tempRoots.push(root);

  const shallowDir = join(root, 'Shallow');
  mkdirSync(shallowDir, { recursive: true });
  writeFileSync(join(shallowDir, 'Shallow.tsx'), 'export function Shallow() { return null; }\n');

  const nestedDir = join(root, 'groups', 'forms', 'Nested');
  mkdirSync(nestedDir, { recursive: true });
  writeFileSync(join(nestedDir, 'Nested.tsx'), 'export function Nested() { return null; }\n');
  writeFileSync(join(nestedDir, 'Nested.json'), JSON.stringify({
    name: 'Nested',
    props: {
      label: { type: 'string', required: true },
      tone: { type: 'string', options: ['neutral', 'danger'], default: 'neutral' },
      checked: { type: 'union', options: [true, false, 'indeterminate', null] },
    },
    states: [
      { name: 'danger', props: { tone: 'danger' } },
    ],
  }));

  return root;
}

afterEach(() => {
  clearRegistryCache();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('scanRegistry', () => {
  it('keeps default scans shallow', () => {
    const root = makeTempRegistry();

    const index = scanRegistry(root, { cache: false });

    expect(index.components.map(c => c.name)).toEqual(['Shallow']);
  });

  it('finds nested components and reads co-located JSON contracts when recursive', () => {
    const root = makeTempRegistry();

    const index = scanRegistry(root, { cache: false, recursive: true });
    const nested = index.components.find(c => c.name === 'Nested');

    expect(index.components.map(c => c.name)).toEqual(['Nested', 'Shallow']);
    expect(nested).toMatchObject({
      name: 'Nested',
      relativePath: join('groups', 'forms', 'Nested'),
      entry: 'Nested.tsx',
      hasFaceJson: true,
      statesCount: 1,
    });
    expect(nested?.props).toEqual([
      { name: 'label', type: 'string', required: true },
      { name: 'tone', type: 'string', required: false, options: ['neutral', 'danger'], defaultValue: 'neutral' },
      { name: 'checked', type: 'union', required: false, options: ['true', 'false', 'indeterminate', 'null'] },
    ]);
  });

  it('preserves legacy top-level controls after v2 face.json parsing', () => {
    const root = makeTempRegistry();
    const legacyDir = join(root, 'LegacyControls');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, 'LegacyControls.tsx'),
      'export function LegacyControls() { return null; }\n',
    );
    writeFileSync(join(legacyDir, 'LegacyControls.json'), JSON.stringify({
      name: 'LegacyControls',
      controls: [
        {
          name: 'visible',
          type: 'boolean',
          required: true,
          options: [true, false, null],
          defaultValue: true,
        },
      ],
      states: [
        { name: 'hidden', props: { visible: false } },
      ],
    }));

    const index = scanRegistry(root, { cache: false });
    const legacy = index.components.find(c => c.name === 'LegacyControls');

    expect(legacy).toMatchObject({
      name: 'LegacyControls',
      hasFaceJson: true,
      statesCount: 1,
    });
    expect(legacy?.props).toEqual([
      {
        name: 'visible',
        type: 'boolean',
        required: true,
        options: ['true', 'false', 'null'],
        defaultValue: 'true',
      },
    ]);
  });

  it('indexes multiple production component entries in a domain directory', () => {
    const root = makeTempRegistry();
    const domainDir = join(root, 'Chat');
    mkdirSync(domainDir, { recursive: true });
    writeFileSync(join(domainDir, 'ChatInput.tsx'), 'export function ChatInput(props: { disabled?: boolean }) { return null; }\n');
    writeFileSync(join(domainDir, 'ChatMessage.tsx'), 'export function ChatMessage(props: { role: "user" | "assistant" }) { return null; }\n');
    writeFileSync(join(domainDir, 'ChatMessage.props.tsx'), 'export type ChatMessageProps = { role: "user" | "assistant" };\n');
    writeFileSync(join(domainDir, 'Chat.context.tsx'), 'export const ChatContext = null;\n');
    writeFileSync(join(domainDir, 'ChatUtils.tsx'), 'export function formatChat() { return null; }\n');
    writeFileSync(join(domainDir, 'index.tsx'), 'export * from "./ChatInput"; export * from "./ChatMessage";\n');
    writeFileSync(join(domainDir, 'ChatMessage.test.tsx'), 'export function ChatMessageTest() { return null; }\n');
    writeFileSync(join(domainDir, 'ChatMessage.json'), JSON.stringify({
      name: 'ChatMessage',
      props: {
        role: { type: 'enum', required: true, options: ['user', 'assistant'] },
      },
    }));

    const index = scanRegistry(root, { cache: false });

    expect(index.components.map(c => c.name)).toEqual(['ChatInput', 'ChatMessage', 'Shallow']);
    expect(index.components.find(c => c.name === 'ChatInput')).toMatchObject({
      relativePath: join('Chat', 'ChatInput.tsx'),
      entry: 'ChatInput.tsx',
      hasFaceJson: false,
    });
    expect(index.components.find(c => c.name === 'ChatMessage')).toMatchObject({
      relativePath: join('Chat', 'ChatMessage.tsx'),
      entry: 'ChatMessage.tsx',
      hasFaceJson: true,
    });
  });

  it('uses the directory name for an index-only component entry', () => {
    const root = makeTempRegistry();
    const indexOnlyDir = join(root, 'IndexOnly');
    mkdirSync(indexOnlyDir, { recursive: true });
    writeFileSync(join(indexOnlyDir, 'index.tsx'), 'export function IndexOnly() { return null; }\n');

    const index = scanRegistry(root, { cache: false });

    expect(index.components.map(c => c.name)).toEqual(['IndexOnly', 'Shallow']);
    expect(index.components.find(c => c.name === 'IndexOnly')).toMatchObject({
      relativePath: 'IndexOnly',
      entry: 'index.tsx',
    });
  });

  it('uses canonical face file ordering and recognizes face.face.json', () => {
    const root = makeTempRegistry();
    const canonicalDir = join(root, 'CanonicalFace');
    mkdirSync(canonicalDir, { recursive: true });
    writeFileSync(join(canonicalDir, 'CanonicalFace.tsx'), 'export function CanonicalFace() { return null; }\n');
    writeFileSync(join(canonicalDir, 'face.json'), JSON.stringify({
      name: 'CanonicalFace',
      props: {
        label: { type: 'string', default: 'folder' },
      },
    }));
    writeFileSync(join(canonicalDir, 'CanonicalFace.json'), JSON.stringify({
      name: 'CanonicalFace',
      props: {
        label: { type: 'string', default: 'canonical' },
      },
    }));

    const alternateDir = join(root, 'AlternateFace');
    mkdirSync(alternateDir, { recursive: true });
    writeFileSync(join(alternateDir, 'AlternateFace.tsx'), 'export function AlternateFace() { return null; }\n');
    writeFileSync(join(alternateDir, 'face.face.json'), JSON.stringify({
      name: 'AlternateFace',
      props: {
        tone: { type: 'string', default: 'alternate' },
      },
    }));

    const index = scanRegistry(root, { cache: false });
    const canonical = index.components.find(c => c.name === 'CanonicalFace');
    const alternate = index.components.find(c => c.name === 'AlternateFace');

    expect(canonical).toMatchObject({ hasFaceJson: true });
    expect(canonical?.props).toEqual([
      { name: 'label', type: 'string', required: false, defaultValue: 'canonical' },
    ]);
    expect(alternate).toMatchObject({ hasFaceJson: true });
    expect(alternate?.props).toEqual([
      { name: 'tone', type: 'string', required: false, defaultValue: 'alternate' },
    ]);
  });

  it('extracts a conservative prop signal from modern destructured wrappers', () => {
    const root = makeTempRegistry();
    const wrapperDir = join(root, 'Button');
    mkdirSync(wrapperDir, { recursive: true });
    writeFileSync(join(wrapperDir, 'Button.tsx'), [
      'function Button({',
      '  className,',
      '  variant = "default",',
      '  size = "md",',
      '  ...props',
      '}: React.ComponentProps<"button"> & VariantProps<typeof variants>) {',
      '  return <button className={className} {...props} />;',
      '}',
    ].join('\n'));

    const index = scanRegistry(root, { cache: false });

    expect(index.components.find(c => c.name === 'Button')?.props).toEqual([
      expect.objectContaining({ name: 'className', type: 'any', required: false }),
      expect.objectContaining({ name: 'variant', type: 'string', required: false }),
      expect.objectContaining({ name: 'size', type: 'string', required: false }),
    ]);
  });

  it('honors recursive maxDepth boundary', () => {
    const root = makeTempRegistry();

    const allowedDir = join(root, 'groups', 'AllowedAtDepth2');
    mkdirSync(allowedDir, { recursive: true });
    writeFileSync(
      join(allowedDir, 'AllowedAtDepth2.tsx'),
      'export function AllowedAtDepth2() { return null; }\n',
    );

    const tooDeepDir = join(root, 'groups', 'forms', 'TooDeep');
    mkdirSync(tooDeepDir, { recursive: true });
    writeFileSync(join(tooDeepDir, 'TooDeep.tsx'), 'export function TooDeep() { return null; }\n');

    const index = scanRegistry(root, { cache: false, recursive: true, maxDepth: 2 });

    expect(index.components.map(c => c.name)).toEqual(['AllowedAtDepth2', 'Shallow']);
  });

  it('ignores dependency, fixture and test-only directories during component discovery', () => {
    const root = makeTempRegistry();

    const componentWithTestDir = join(root, 'WithTest');
    mkdirSync(componentWithTestDir, { recursive: true });
    writeFileSync(join(componentWithTestDir, 'WithTest.test.tsx'), 'export function WithTestSpec() { return null; }\n');
    writeFileSync(join(componentWithTestDir, 'WithTest.tsx'), 'export function WithTest() { return null; }\n');
    const mockDir = join(componentWithTestDir, '__mocks__');
    mkdirSync(mockDir, { recursive: true });
    writeFileSync(join(mockDir, 'WithTest.tsx'), 'export function MockWithTest() { return null; }\n');

    const testOnlyDir = join(root, 'TestOnly');
    mkdirSync(testOnlyDir, { recursive: true });
    writeFileSync(join(testOnlyDir, 'TestOnly.test.tsx'), 'export function TestOnly() { return null; }\n');

    const dependencyDir = join(root, 'node_modules', '@vendor', 'IgnoredDependency');
    mkdirSync(dependencyDir, { recursive: true });
    writeFileSync(join(dependencyDir, 'IgnoredDependency.tsx'), 'export function IgnoredDependency() { return null; }\n');

    const fixtureDir = join(root, 'fixtures', 'IgnoredFixture');
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(join(fixtureDir, 'IgnoredFixture.tsx'), 'export function IgnoredFixture() { return null; }\n');

    const index = scanRegistry(root, { cache: false, recursive: true });

    expect(index.components.map(c => c.name)).toEqual(['Nested', 'Shallow', 'WithTest']);
    expect(index.components.find(c => c.name === 'WithTest')?.entry).toBe('WithTest.tsx');
  });
});
