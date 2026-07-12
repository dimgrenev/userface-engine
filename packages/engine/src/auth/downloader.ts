import { existsSync, mkdirSync, createWriteStream, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import fetch from 'node-fetch';
import { pipeline } from 'node:stream/promises';
import { loadTarModule } from './optionalDeps';

export async function downloadAndExtractLibrary(
  url: string,
  targetDir: string,
  token?: string
): Promise<void> {
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  process.stderr.write(`Downloading ${url}...\n`);
  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`Failed to download library: ${response.status} ${response.statusText}`);
  }

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  // Create a temporary file for the tarball
  const tempFile = resolve(targetDir, '.uf-temp.tar.gz');
  
  try {
    const tar = loadTarModule();

    // 1. Download to temp file
    if (!response.body) throw new Error('No response body');
    await pipeline(response.body, createWriteStream(tempFile));

    // 2. Extract tarball
    process.stderr.write(`Extracting to ${targetDir}...\n`);
    await tar.x({
      file: tempFile,
      cwd: targetDir,
      strip: 1, // Strip the top-level directory from the tarball
    });

    process.stderr.write(`Extracted successfully.\n`);
  } catch (error) {
    throw new Error(`Extraction failed: ${error}`);
  } finally {
    // 3. Cleanup temp file
    if (existsSync(tempFile)) {
      unlinkSync(tempFile);
    }
  }
}

export function saveManifest(targetDir: string, id: string, version: string) {
  const manifestPath = resolve(targetDir, '__uf_manifest.json');
  const manifest = {
    id,
    version,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}
