import { spawnSync } from 'node:child_process';

const packages = [
  ['@userface/engine', 'packages/engine'],
  ['userface', 'packages/userface'],
];

for (const [name, cwd] of packages) {
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
