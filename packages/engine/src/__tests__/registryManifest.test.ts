import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRegistryManifest, RegistryManifestError } from '../registryManifest.ts';

const tempRoots: string[] = [];

function repoRoot(): string {
  const cwd = process.cwd();
  if (cwd.endsWith(join('packages', 'engine'))) return resolve(cwd, '../..');
  return cwd;
}

function makeTempPackage(packageName = '@demo/components') {
  const repoRoot = mkdtempSync(join(tmpdir(), 'userface-registry-manifest-'));
  tempRoots.push(repoRoot);

  const packageRoot = join(repoRoot, 'packages', 'components');
  mkdirSync(join(packageRoot, 'Button'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: packageName }));
  writeFileSync(join(packageRoot, 'Button', 'Button.tsx'), 'export function Button() { return null; }\n');
  writeFileSync(join(packageRoot, 'Button', 'Button.json'), JSON.stringify({ name: 'Button' }));

  return {
    repoRoot,
    packageRoot,
    manifestPath: join(packageRoot, 'component-registry.json'),
    writeManifest(value: unknown) {
      writeFileSync(join(packageRoot, 'component-registry.json'), JSON.stringify(value, null, 2));
    },
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('loadRegistryManifest', () => {
  it('loads the current UF default-private registry manifest', () => {
    const root = repoRoot();
    const loaded = loadRegistryManifest(resolve(root, 'packages/uf/component-registry.json'), { repoRoot: root });

    expect(loaded.manifest.package).toBe('@userface/uf');
    expect(loaded.manifest.defaultRegistryVisibility).toBe('private');
    expect(loaded.components.filter(component => component.registryVisibility === 'public')).toHaveLength(27);
    expect(loaded.components.map(component => component.name)).toContain('Form');
    expect(loaded.components.map(component => component.name)).toContain('Textarea');
    expect(loaded.components.map(component => component.name)).toContain('PriceButton');
  });

  it('loads a valid manifest and resolves component files from the package root', () => {
    const fixture = makeTempPackage();
    fixture.writeManifest({
      version: 1,
      package: '@demo/components',
      defaultRegistryVisibility: 'private',
      components: {
        Button: {
          registryVisibility: 'public',
          entry: './Button/Button.tsx',
          contract: './Button/Button.json',
          patterns: ['form'],
          context: 'demo',
        },
      },
    });

    const loaded = loadRegistryManifest(fixture.manifestPath, { repoRoot: fixture.repoRoot });
    const packageRoot = realpathSync.native(fixture.packageRoot);

    expect(loaded).toMatchObject({
      manifestPath: fixture.manifestPath,
      packageRoot,
      repoRoot: realpathSync.native(fixture.repoRoot),
      manifest: {
        package: '@demo/components',
        defaultRegistryVisibility: 'private',
      },
    });
    expect(loaded.components).toEqual([
      expect.objectContaining({
        name: 'Button',
        registryVisibility: 'public',
        entry: './Button/Button.tsx',
        contract: './Button/Button.json',
        entryPath: join(packageRoot, 'Button', 'Button.tsx'),
        contractPath: join(packageRoot, 'Button', 'Button.json'),
        patterns: ['form'],
        context: 'demo',
      }),
    ]);
  });

  it('reports unreadable JSON manifests', () => {
    const fixture = makeTempPackage();
    writeFileSync(fixture.manifestPath, '{');

    expect(() => loadRegistryManifest(fixture.manifestPath, { repoRoot: fixture.repoRoot }))
      .toThrow(RegistryManifestError);

    try {
      loadRegistryManifest(fixture.manifestPath, { repoRoot: fixture.repoRoot });
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryManifestError);
      expect((error as RegistryManifestError).issues).toEqual([
        expect.objectContaining({ path: 'manifestPath' }),
      ]);
    }
  });

  it('validates package and visibility manifest fields', () => {
    const fixture = makeTempPackage();
    fixture.writeManifest({
      version: 1,
      package: '@demo/wrong',
      defaultRegistryVisibility: 'internal',
      components: {
        Button: {
          registryVisibility: 'visible',
          entry: './Button/Button.tsx',
          contract: './Button/Button.json',
        },
      },
    });

    try {
      loadRegistryManifest(fixture.manifestPath, { repoRoot: fixture.repoRoot });
      throw new Error('expected manifest validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryManifestError);
      const issuePaths = (error as RegistryManifestError).issues.map(issue => issue.path);
      expect(issuePaths).toEqual([
        'package',
        'defaultRegistryVisibility',
        'components.Button.registryVisibility',
      ]);
    }
  });

  it('validates component entry and contract path contracts', () => {
    const fixture = makeTempPackage();
    fixture.writeManifest({
      version: 1,
      package: '@demo/components',
      defaultRegistryVisibility: 'private',
      components: {
        Button: {
          registryVisibility: 'public',
          entry: 'Button/Button.tsx',
          contract: './../Button.json',
        },
        Missing: {
          registryVisibility: 'public',
          entry: './Missing/Missing.tsx',
          contract: './Missing/Missing.json',
        },
      },
    });

    try {
      loadRegistryManifest(fixture.manifestPath, { repoRoot: fixture.repoRoot });
      throw new Error('expected manifest validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryManifestError);
      expect((error as RegistryManifestError).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'components.Button.entry', message: 'must start with "./"' }),
          expect.objectContaining({ path: 'components.Button.contract', message: 'must stay within the package root' }),
          expect.objectContaining({ path: 'components.Button.contract', message: 'must point to an existing file' }),
          expect.objectContaining({ path: 'components.Missing.entry', message: 'must point to an existing file' }),
          expect.objectContaining({ path: 'components.Missing.contract', message: 'must point to an existing file' }),
        ]),
      );
    }
  });

  it('rejects manifest symlinks that escape the package root', () => {
    const fixture = makeTempPackage();
    const outsideManifest = join(fixture.repoRoot, 'outside-registry.json');
    writeFileSync(outsideManifest, JSON.stringify({
      version: 1,
      package: '@demo/components',
      defaultRegistryVisibility: 'private',
      components: {},
    }));
    symlinkSync(outsideManifest, fixture.manifestPath);

    try {
      loadRegistryManifest(fixture.manifestPath, { repoRoot: fixture.repoRoot });
      throw new Error('expected manifest validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryManifestError);
      expect((error as RegistryManifestError).issues).toEqual([
        expect.objectContaining({
          path: 'manifestPath',
          message: 'must stay within the package root',
        }),
      ]);
    }
  });

  it('rejects component entry and contract symlinks that escape the package root', () => {
    const fixture = makeTempPackage();
    const outsideDir = join(fixture.repoRoot, 'outside-component');
    const escapedDir = join(fixture.packageRoot, 'Escaped');
    mkdirSync(outsideDir, { recursive: true });
    mkdirSync(escapedDir, { recursive: true });
    writeFileSync(join(outsideDir, 'Escaped.tsx'), 'export function Escaped() { return null; }\n');
    writeFileSync(join(outsideDir, 'Escaped.json'), JSON.stringify({ name: 'Escaped' }));
    symlinkSync(join(outsideDir, 'Escaped.tsx'), join(escapedDir, 'Escaped.tsx'));
    symlinkSync(join(outsideDir, 'Escaped.json'), join(escapedDir, 'Escaped.json'));
    fixture.writeManifest({
      version: 1,
      package: '@demo/components',
      defaultRegistryVisibility: 'private',
      components: {
        Escaped: {
          registryVisibility: 'public',
          entry: './Escaped/Escaped.tsx',
          contract: './Escaped/Escaped.json',
        },
      },
    });

    try {
      loadRegistryManifest(fixture.manifestPath, { repoRoot: fixture.repoRoot });
      throw new Error('expected manifest validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryManifestError);
      expect((error as RegistryManifestError).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'components.Escaped.entry',
            message: 'must stay within the package root',
          }),
          expect.objectContaining({
            path: 'components.Escaped.contract',
            message: 'must stay within the package root',
          }),
        ]),
      );
    }
  });

  it('validates that contract names match registry keys', () => {
    const fixture = makeTempPackage();
    writeFileSync(join(fixture.packageRoot, 'Button', 'Button.json'), JSON.stringify({ name: 'WrongName' }));
    fixture.writeManifest({
      version: 1,
      package: '@demo/components',
      defaultRegistryVisibility: 'private',
      components: {
        Button: {
          registryVisibility: 'public',
          entry: './Button/Button.tsx',
          contract: './Button/Button.json',
        },
      },
    });

    try {
      loadRegistryManifest(fixture.manifestPath, { repoRoot: fixture.repoRoot });
      throw new Error('expected manifest validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryManifestError);
      expect((error as RegistryManifestError).issues).toEqual([
        expect.objectContaining({
          path: 'components.Button.contract.name',
          message: 'must match the registry component name',
        }),
      ]);
    }
  });
});
