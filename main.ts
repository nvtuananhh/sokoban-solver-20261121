// Sokoban solver: push-optimal, deterministic, work-budgeted.
//
// Strategy (written for this entry; no code copied from the kit's baseline
// or generator): the drawn levels are a 1-wide hallway plus independent
// rooms, each with one door. A box pushed out of a door can never return,
// so a level's push optimum is the sum of its rooms' optima. The solver
// therefore splits a level into rooms (dead-square analysis cuts the
// hallway), solves each room on its own with A* over PUSH states, and
// joins the room solutions by walking the hallway. A room search that
// fails falls back to a greedy push search for that room, and a level
// that does not split into rooms falls back to a whole-level search.
//
// A push state is the sorted box squares plus the player's reachable
// region (named by its lowest square): walks cost no pushes, so every
// player square in one region is the same state. The heuristic is the
// minimum-cost assignment of boxes to goals under shortest-path
// (walls-only) distances, which is admissible: one push moves one box
// one square, so it can lower the assignment cost by at most one.
// Pruning is sound: a box on a dead square (no pull path to any goal)
// and a frozen 2x2 block of walls/boxes holding an off-goal box can
// never be part of a solution, so pruning them keeps the optimum.
//
// Determinism: no clock, no randomness, no environment input beyond the
// input/output directories. Every search is cut off by a fixed count of
// expanded states, ties break by a fixed sequence number, and all
// iteration orders are fixed. Two runs therefore write identical bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Fixed work budgets (expanded states). Never wall-clock: the sandbox
// gives the whole 5-instance set 60 seconds, and a clock cutoff would
// make two runs differ.
const ROOM_ASTAR_BUDGET = 250000;
const ROOM_GREEDY_BUDGET = 250000;
const WHOLE_ASTAR_BUDGET = 400000;
const WHOLE_GREEDY_BUDGET = 400000;

const INF = 1000000000;

// Directions in fixed order: up, down, left, right.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const WALK_LETTER = ['u', 'd', 'l', 'r'];
const PUSH_LETTER = ['U', 'D', 'L', 'R'];

type Level = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  goalSet: Uint8Array;
  boxes: number[];
  player: number;
};

/** Parse XSB text exactly as the checker reads it: rows are the
 * non-empty lines, the width is the longest row, a missing character
 * (short row) is a wall, and anything but '#' is open floor. The board
 * is padded with one wall ring so every neighbour index stays in range. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h0 = rows.length;
  const w0 = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const w = w0 + 2;
  const h = h0 + 2;
  const wall = new Uint8Array(w * h).fill(1);
  const goalSet = new Uint8Array(w * h);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y0) => {
    for (let x0 = 0; x0 < row.length; x0++) {
      const ch = row[x0] as string;
      if (ch === '#') continue;
      const i = (y0 + 1) * w + (x0 + 1);
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') {
        goalSet[i] = 1;
        goals.push(i);
      }
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, goalSet, boxes, player };
}

/** Squares from which a lone box can be pulled back onto some goal:
 * start at the goals and walk backwards; a square y is live when the
 * square beyond it (y - d) is open and the square x = y + d it came
 * from is live. A box on any other square can never reach a goal. */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi] as number;
    for (let k = 0; k < 4; k++) {
      const d = DY[k] as number * w + (DX[k] as number);
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Shortest walking distances (walls only, boxes ignored) from each
 * goal, as a flat [goal][square] table. Unreachable squares get INF. */
function goalDistances(level: Level): Int32Array {
  const { w, wall, goals } = level;
  const size = wall.length;
  const dist = new Int32Array(goals.length * size).fill(INF);
  for (let gi = 0; gi < goals.length; gi++) {
    const g = goals[gi] as number;
    const base = gi * size;
    const queue: number[] = [g];
    dist[base + g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi] as number;
      const nd = dist[base + p] as number + 1;
      for (let k = 0; k < 4; k++) {
        const q = p + (DY[k] as number) * w + (DX[k] as number);
        if (!wall[q] && dist[base + q] === INF) {
          dist[base + q] = nd;
          queue.push(q);
        }
      }
    }
  }
  return dist;
}

/** Admissible heuristic: minimum-cost box->goal assignment under the
 * walls-only distances (exact assignment for up to 6 boxes by
 * branch-and-bound over goal permutations; sum of per-box minima for
 * larger sets, which is still admissible). INF when some box cannot
 * reach any goal. */
function heuristic(
  boxes: number[],
  dist: Int32Array,
  nGoals: number,
  size: number,
): number {
  const n = boxes.length;
  if (n === 0) return 0;
  if (n > 6) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      let best = INF;
      const b = boxes[i] as number;
      for (let gi = 0; gi < nGoals; gi++) {
        const d = dist[gi * size + b] as number;
        if (d < best) best = d;
      }
      if (best >= INF) return INF;
      total += best;
    }
    return total;
  }
  // Branch and bound: assign goals to boxes in box order.
  let best = INF;
  const used = new Uint8Array(nGoals);
  const rec = (i: number, partial: number): void => {
    if (partial >= best) return;
    if (i === n) {
      best = partial;
      return;
    }
    const b = boxes[i] as number;
    for (let gi = 0; gi < nGoals; gi++) {
      if (used[gi]) continue;
      const d = dist[gi * size + b] as number;
      if (d >= INF) continue;
      used[gi] = 1;
      rec(i + 1, partial + d);
      used[gi] = 0;
    }
  };
  rec(0, 0);
  return best;
}

/** Flood-fill the player's reachable region from `from` around walls
 * and the boxes marked in `occupied`, stamping `seen` with `stamp`.
 * Returns the region's lowest square (the state's canonical player
 * representative). `stack` is scratch space. */
function floodRegion(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n] as number;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = p + (DY[k] as number) * w + (DX[k] as number);
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block: four
 * squares, each a wall or a box, holding at least one box off its
 * goal. No box in such a block can ever move again. */
function frozenAt(
  level: Level,
  occupied: Uint8Array,
  goalSet: Uint8Array,
  t: number,
): boolean {
  const { w, wall } = level;
  const starts = [t, t - 1, t - w, t - w - 1];
  for (const a of starts) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a])) continue;
    if (!(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c])) continue;
    if (!(wall[d] || occupied[d])) continue;
    if (
      (occupied[a] && !goalSet[a]) ||
      (occupied[b] && !goalSet[b]) ||
      (occupied[c] && !goalSet[c]) ||
      (occupied[d] && !goalSet[d])
    ) {
      return true;
    }
  }
  return false;
}

/** Shortest walk from `from` to `to` around walls and `occupied`
 * boxes, in lowercase LURD, breaking ties by direction order u, d, l,
 * r. Throws when `to` is unreachable (cannot happen for a generated
 * push square). */
function walkTo(
  level: Level,
  occupied: Uint8Array,
  from: number,
  to: number,
): string {
  if (from === to) return '';
  const { w, wall } = level;
  const size = wall.length;
  const prev = new Int32Array(size).fill(-1);
  const how = new Uint8Array(size);
  const queue = new Int32Array(size);
  let qh = 0;
  let qt = 0;
  queue[qt++] = from;
  prev[from] = from;
  while (qh < qt) {
    const p = queue[qh++] as number;
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + (DY[k] as number) * w + (DX[k] as number);
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = k;
      queue[qt++] = q;
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square unreachable');
  let s = '';
  for (let p = to; p !== from; p = prev[p] as number) {
    s = WALK_LETTER[how[p] as number] + s;
  }
  return s;
}

type SearchResult = {
  moves: string;
  pushes: number;
  expansions: number;
  proven: boolean;
};

/**
 * Push-space search over one sub-level (a room, or the whole level).
 * A* when `greedy` is false (first goal popped is push-optimal: the
 * heuristic is consistent and the pruning is sound), best-first on
 * the heuristic alone when true (finds a valid solution fast, with no
 * optimality claim). Returns null when the state budget runs out
 * before any goal state is reached.
 */
function searchPush(
  level: Level,
  budget: number,
  greedy: boolean,
): SearchResult | null {
  const { w, wall, goals, goalSet, boxes: startBoxes, player: startPlayer } = level;
  const size = wall.length;
  const nBoxes = startBoxes.length;
  const live = liveSquares(level);
  for (const b of startBoxes) if (!live[b]) return null;
  const dist = goalDistances(level);
  const nGoals = goals.length;

  const solved = (bs: number[]): boolean => bs.every((b) => goalSet[b] === 1);

  // State storage: boxes, the player square after the push that made
  // the state, the region's lowest square, g, parent, and the push.
  const stateBoxes: number[][] = [startBoxes.slice()];
  const statePlayer: number[] = [startPlayer];
  const stateLow: number[] = [0];
  const stateG: number[] = [0];
  const stateParent: number[] = [-1];
  const stateFrom: number[] = [-1];
  const stateTo: number[] = [-1];
  const stateDir: number[] = [-1];

  const occupied = new Uint8Array(size);
  const seenA = new Int32Array(size);
  const seenB = new Int32Array(size);
  const stack = new Int32Array(size);
  let stampA = 0;
  let stampB = 0;
  for (const b of startBoxes) occupied[b] = 1;
  stateLow[0] = floodRegion(level, occupied, startPlayer, seenA, ++stampA, stack);
  for (const b of startBoxes) occupied[b] = 0;

  // A state's key: region representative + boxes, as one number while
  // it stays exact (size ** (boxes + 1) < 2^53), else a string.
  const numericKeys = Math.pow(size, nBoxes + 1) < Number.MAX_SAFE_INTEGER;
  const keyOf = (bs: number[], low: number): number | string => {
    if (numericKeys) {
      let k = low;
      for (const b of bs) k = k * size + b;
      return k;
    }
    return bs.join(',') + '|' + low;
  };

  const best = new Map<number | string, number>();
  best.set(keyOf(startBoxes, stateLow[0] as number), 0);

  // Binary heap of [priority, -g, sequence, state index]. Priority is
  // g + h for A*, h alone for greedy. Ties: deeper first, then the
  // fixed insertion order, so the run is fully deterministic.
  type Entry = [number, number, number, number];
  const heap: Entry[] = [];
  const heapLess = (a: Entry, b: Entry): boolean =>
    a[0] < b[0] ||
    (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: Entry): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i] as Entry, heap[p] as Entry)) break;
      const t = heap[i] as Entry;
      heap[i] = heap[p] as Entry;
      heap[p] = t;
      i = p;
    }
  };
  const heapPop = (): Entry => {
    const top = heap[0] as Entry;
    const last = heap.pop() as Entry;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1] as Entry, heap[c] as Entry)) c++;
        if (!heapLess(heap[c] as Entry, heap[i] as Entry)) break;
        const t = heap[i] as Entry;
        heap[i] = heap[c] as Entry;
        heap[c] = t;
        i = c;
      }
    }
    return top;
  };

  const h0 = heuristic(startBoxes, dist, nGoals, size);
  if (h0 >= INF) return null;
  let seq = 0;
  heapPush([greedy ? h0 : h0, 0, seq++, 0]);

  let expansions = 0;
  let found = -1;
  while (heap.length > 0) {
    const entry = heapPop();
    const s = entry[3];
    const g = stateG[s] as number;
    if (best.get(keyOf(stateBoxes[s] as number[], stateLow[s] as number)) !== s) continue;
    if (entry[1] !== -g) continue;
    const bs = stateBoxes[s] as number[];
    if (solved(bs)) {
      found = s;
      break;
    }
    if (expansions >= budget) return null;
    expansions++;

    for (const b of bs) occupied[b] = 1;
    const regionStamp = ++stampA;
    floodRegion(level, occupied, statePlayer[s] as number, seenA, regionStamp, stack);
    for (let bi = 0; bi < bs.length; bi++) {
      const b = bs[bi] as number;
      for (let k = 0; k < 4; k++) {
        const d = (DY[k] as number) * w + (DX[k] as number);
        const stand = b - d;
        if (seenA[stand] !== regionStamp) continue;
        const t = b + d;
        if (wall[t] || occupied[t] || !live[t]) continue;
        // Move the box provisionally: frozen check, then the new
        // region, then restore before the next successor.
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenAt(level, occupied, goalSet, t);
        let next: number[] | null = null;
        let low = 0;
        let h = INF;
        if (!frozen) {
          next = bs.slice();
          next[bi] = t;
          next.sort((a, b2) => a - b2);
          low = floodRegion(level, occupied, b, seenB, ++stampB, stack);
          h = heuristic(next, dist, nGoals, size);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null || h >= INF) continue;
        const key = keyOf(next, low);
        const g2 = g + 1;
        const prevIdx = best.get(key);
        if (prevIdx !== undefined && (stateG[prevIdx] as number) <= g2) continue;
        const idx = stateBoxes.length;
        best.set(key, idx);
        stateBoxes.push(next);
        statePlayer.push(b);
        stateLow.push(low);
        stateG.push(g2);
        stateParent.push(s);
        stateFrom.push(b);
        stateTo.push(t);
        stateDir.push(k);
        heapPush([greedy ? h : g2 + h, -g2, seq++, idx]);
      }
    }
    for (const b of bs) occupied[b] = 0;
  }
  if (found < 0) return null;

  // Reconstruct: walk to each push square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = stateParent[s] as number) path.push(s);
  path.reverse();
  let moves = '';
  let boxes = startBoxes.slice();
  for (const s of path) {
    const from = stateFrom[s] as number;
    const to = stateTo[s] as number;
    const k = stateDir[s] as number;
    const d = (DY[k] as number) * w + (DX[k] as number);
    for (const b of boxes) occupied[b] = 1;
    const parentState = stateParent[s] as number;
    moves += walkTo(level, occupied, statePlayer[parentState] as number, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += PUSH_LETTER[k];
    boxes = stateBoxes[s] as number[];
    void to;
    void d;
  }
  return { moves, pushes: path.length, expansions, proven: !greedy };
}

type Room = {
  boxes: number[];
  goals: number[];
  done: boolean;
};

/** Split a level into rooms: cut the hallway row's dead squares out
 * of the floor, and each remaining component holding boxes is a room.
 * Returns null when the level is not a clean set of rooms (a box in
 * the hallway, a goal outside every room, or a room whose box and
 * goal counts differ) so the caller can solve the whole level. */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const comps: number[][] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares: number[] = [s];
    part[s] = comps.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i] as number;
      for (let k = 0; k < 4; k++) {
        const q = p + (DY[k] as number) * w + (DX[k] as number);
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = comps.length;
          squares.push(q);
        }
      }
    }
    comps.push(squares);
  }
  const rooms: Room[] = comps.map(() => ({ boxes: [], goals: [], done: false }));
  for (const b of boxes) {
    const p = part[b] as number;
    if (p < 0) return null;
    (rooms[p] as Room).boxes.push(b);
  }
  for (const g of goals) {
    const p = part[g] as number;
    if (p < 0) return null;
    (rooms[p] as Room).goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  const out = rooms.filter((r) => r.boxes.length > 0);
  for (const r of out) {
    r.boxes.sort((a, b) => a - b);
    r.goals.sort((a, b) => a - b);
  }
  return out;
}

/** Advance the player square by a move string (case-insensitive). */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

type SolveReport = { moves: string; pushes: number; expansions: number; proven: boolean };

/** Solve one level: room by room when it splits, else whole-level.
 * Returns the move string plus per-level search statistics (written
 * to stderr by the driver; never part of the answer files). */
function solveLevel(level: Level): SolveReport {
  const { w, wall, goalSet } = level;
  const total = { moves: '', pushes: 0, expansions: 0, proven: true };
  if (level.boxes.every((b) => goalSet[b] === 1)) return total;

  const rooms = roomsOf(level);
  if (rooms !== null) {
    let player = level.player;
    for (const room of rooms) {
      const subWall = wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const b of other.done ? other.goals : other.boxes) subWall[b] = 1;
      }
      const sub: Level = {
        w,
        h: level.h,
        wall: subWall,
        goals: room.goals.slice(),
        goalSet: (() => {
          const gs = new Uint8Array(wall.length);
          for (const g of room.goals) gs[g] = 1;
          return gs;
        })(),
        boxes: room.boxes.slice(),
        player,
      };
      let solved = searchPush(sub, ROOM_ASTAR_BUDGET, false);
      if (solved === null) solved = searchPush(sub, ROOM_GREEDY_BUDGET, true);
      if (solved === null) {
        // Room search gave up: try the whole level instead.
        const whole = searchPush(level, WHOLE_ASTAR_BUDGET, false) ??
          searchPush(level, WHOLE_GREEDY_BUDGET, true);
        if (whole === null) return { moves: '', pushes: 0, expansions: total.expansions, proven: false };
        return { moves: whole.moves, pushes: whole.pushes, expansions: total.expansions + whole.expansions, proven: whole.proven };
      }
      total.moves += solved.moves;
      total.pushes += solved.pushes;
      total.expansions += solved.expansions;
      if (!solved.proven) total.proven = false;
      player = endOf(w, player, solved.moves);
      room.done = true;
    }
    return total;
  }

  const whole = searchPush(level, WHOLE_ASTAR_BUDGET, false) ??
    searchPush(level, WHOLE_GREEDY_BUDGET, true);
  if (whole === null) return { moves: '', pushes: 0, expansions: 0, proven: false };
  return { moves: whole.moves, pushes: whole.pushes, expansions: whole.expansions, proven: whole.proven };
}

for (const entry of readdirSync(INPUT_DIR, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
  if (!entry.isDirectory()) continue;
  const id = entry.name;
  const text = readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8');
  const report = solveLevel(parseLevel(text));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${report.moves}\n`);
  console.error(`${id}: pushes=${report.pushes} expansions=${report.expansions} proven=${report.proven} moves=${report.moves.length}`);
}
