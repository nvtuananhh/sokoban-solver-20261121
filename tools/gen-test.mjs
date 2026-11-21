// Generate fresh test sets with the kit generator and check this entry
// against them (NOT imported by main.ts). Needs the unpacked kit at
// <kit-dir>; the seed is the sha256 of a label, so each label draws a
// different deterministic set. Prints the scorer's verdict per set.
//
// Usage:
//   node tools/gen-test.mjs <kit-dir> <label> [<label> ...]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolDir = dirname(fileURLToPath(import.meta.url));

const [kitDir, ...labels] = process.argv.slice(2);
if (!kitDir || labels.length === 0) {
  console.error('usage: node tools/gen-test.mjs <kit-dir> <label> [<label> ...]');
  process.exit(2);
}
for (const label of labels) {
  const seed = createHash('sha256').update('sokoban-test-' + label).digest('hex');
  const base = mkdtempSync(join(tmpdir(), 'sok-gen-'));
  const seedIn = join(base, 'seed-in');
  mkdirSync(seedIn, { recursive: true });
  writeFileSync(join(seedIn, 'seed.json'), JSON.stringify({ schema: 'agent-fun/instance-seed/v1', seed }));
  const drawn = join(base, 'drawn');
  execFileSync(process.execPath, [join(kitDir, 'program/generator/draw.ts')], {
    env: { ...process.env, MAKEFUN_INPUT_DIR: seedIn, MAKEFUN_OUTPUT_DIR: drawn },
    stdio: 'ignore',
  });
  execFileSync(process.execPath, [join(toolDir, 'check.mjs'), join(drawn, 'input'), join(drawn, 'reference/manifest.json')], {
    stdio: 'inherit',
    env: { ...process.env },
  });
  console.log(`set ${label} seed=${seed} done`);
}
