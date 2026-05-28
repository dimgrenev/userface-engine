import { spawnSync } from 'node:child_process';

const packageMap = new Map([
  ['@userface/engine', 'packages/engine'],
  ['userface', 'packages/userface'],
]);

const requestedNames = process.argv.slice(2);
const targetNames = requestedNames.length > 0 ? requestedNames : ['@userface/engine', 'userface'];
const unknownNames = targetNames.filter((name) => !packageMap.has(name));

if (unknownNames.length > 0) {
  process.stderr.write(`[pkg:publish] unknown package(s): ${unknownNames.join(', ')}\n`);
  process.stderr.write(`[pkg:publish] known packages: ${[...packageMap.keys()].join(', ')}\n`);
  process.exit(1);
}

for (const name of targetNames) {
  const cwd = packageMap.get(name);
  process.stdout.write(`[pkg:publish] publishing ${name} from ${cwd}\n`);
  const result = spawnSync('npm', ['publish', '--access', 'public'], {
    stdio: 'inherit',
    cwd,
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

process.stdout.write('[pkg:publish] all engine packages published\n');
