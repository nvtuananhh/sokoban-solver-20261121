// Verification harness for this entry (NOT imported by main.ts).
// Runs main.ts twice on an input directory, checks the two runs are
// byte-identical, replays every solution with an independent simulator,
// and, when a manifest.json is given, compares push counts with its P*.
//
// Usage:
//   node tools/check.mjs <input-dir> [manifest.json]
// Exit code 0 only when every solution replays legally to all boxes on
// goals (or matches P* when a manifest is given).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const inputDir = process.argv[2];
const manifestPath = process.argv[3];
if (!inputDir) {
  console.error('usage: node tools/check.mjs <input-dir> [manifest.json]');
  process.exit(2);
}
const manifest = manifestPath ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
const expected = new Map();
if (manifest) for (const inst of manifest.instances) expected.set(inst.id, inst.key.pushes);

function run(outDir) {
  execFileSync(process.execPath, [join(root, 'main.ts')], {
    env: { ...process.env, MAKEFUN_INPUT_DIR: inputDir, MAKEFUN_OUTPUT_DIR: outDir },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

function replay(levelText, movesText) {
  const rows = levelText.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const size = w * rows.length;
  const wall = new Uint8Array(size).fill(1);
  const goal = new Uint8Array(size);
  const box = new Uint8Array(size);
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
      if (ch === '$' || ch === '*') box[i] = 1;
      if (ch === '@' || ch === '+') player = i;
    }
  });
  const moves = movesText.replace(/\s+/g, '');
  if (/[^udlrUDLR]/.test(moves)) return { ok: false, why: 'illegal character in solution' };
  const step = { u: -w, d: w, l: -1, r: 1 };
  let pushes = 0;
  for (let k = 0; k < moves.length; k++) {
    const d = step[moves[k].toLowerCase()];
    const next = player + d;
    if (wall[next]) return { ok: false, why: `move ${k + 1} walks into a wall` };
    if (box[next]) {
      const beyond = next + d;
      if (wall[beyond] || box[beyond]) return { ok: false, why: `move ${k + 1} pushes into a wall/box` };
      box[next] = 0;
      box[beyond] = 1;
      pushes++;
    }
    player = next;
  }
  for (let i = 0; i < size; i++) if (box[i] && !goal[i]) return { ok: false, why: 'box off goal at end', pushes };
  return { ok: true, pushes };
}

const out1 = mkdtempSync(join(tmpdir(), 'sok-check-1-'));
const out2 = mkdtempSync(join(tmpdir(), 'sok-check-2-'));
const t0 = Date.now();
run(out1);
const t1 = Date.now();
run(out2);
const t2 = Date.now();

let allOk = true;
const ids = readdirSync(inputDir).sort();
for (const id of ids) {
  const level = readFileSync(join(inputDir, id, 'level.txt'), 'utf8');
  const a = readFileSync(join(out1, id, 'solution.txt'));
  const b = readFileSync(join(out2, id, 'solution.txt'));
  const ha = createHash('sha256').update(a).digest('hex').slice(0, 16);
  const hb = createHash('sha256').update(b).digest('hex').slice(0, 16);
  const identical = ha === hb;
  const sizeOk = a.length <= 65536;
  const r = replay(level, a.toString('utf8'));
  const want = expected.get(id);
  const optimal = want === undefined ? null : r.ok && r.pushes === want;
  const ok = identical && sizeOk && r.ok && optimal !== false;
  if (!ok) allOk = false;
  console.log(
    `${id}: pushes=${r.ok ? r.pushes : '?'} P*=${want ?? '?'} optimal=${optimal ?? '?'} ` +
      `replay=${r.ok ? 'OK' : 'FAIL ' + r.why} identical=${identical} size=${a.length} hash=${ha}`,
  );
}
console.log(`run1=${t1 - t0}ms run2=${t2 - t1}ms allOk=${allOk}`);
process.exit(allOk ? 0 : 1);
