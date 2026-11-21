# Sokoban solver: fewest pushes

One program, `main.ts` (Node 22, erasable TypeScript, builtins only),
answers all 5 instances of a set in one run. It reads
`$MAKEFUN_INPUT_DIR/<id>/level.txt` (default `/input`) and writes
`$MAKEFUN_OUTPUT_DIR/<id>/solution.txt` (default `/output`) — the
player's moves in LURD, lowercase for walks, uppercase for pushes.

## How it solves

The drawn levels are a 1-wide hallway plus independent rooms, each
with one door; a box pushed out of a door can never return, so a
level's push optimum is the sum of its rooms' optima. The solver:

1. **Splits the level into rooms** with dead-square analysis: squares
   from which a lone box can never be pulled onto a goal are dead,
   and the hallway row's dead squares cut the board into components.
   A level that does not split cleanly is solved whole.
2. **Solves each room with A\* over push states.** A state is the
   sorted box squares plus the player's reachable region (named by
   its lowest square) — walks cost no pushes, so region-mates are
   one state. The heuristic is the minimum-cost box→goal assignment
   under shortest-path (walls-only) distances: admissible, since one
   push moves one box one square. Pruning is sound: dead squares and
   frozen 2×2 blocks of walls/boxes holding an off-goal box.
3. **Joins room solutions** by walking the hallway, carrying the
   player position from room to room.

If a room's A\* exhausts its work budget, a greedy push search tries
for any valid solution for that room; if that also fails, the whole
level is attempted the same way. A level that cannot be solved yields
an empty (valid-format) answer rather than crashing.

## Determinism

No clock, no randomness, no environment input beyond the input/output
directories. Searches are cut off by a fixed count of expanded
states, never by wall time; every tie breaks by a fixed insertion
order. Two runs write byte-identical files (checked by
`tools/check.mjs`).

## Verification

- Practice set: 5/5 at the reference push optima (13, 16, 29, 47, 60),
  scorer result 1,000,000; the house baseline (plain-astar) scores
  200,000 on the same set.
- 12 freshly drawn sets (60 instances) from the kit generator:
  60/60 at P\*, all proven optimal, all byte-identical across runs,
  worst set under 0.7 s on this VM (budget: 60 s for the whole set).
- Hand-built edge levels under `tools/edge/input/`: hallway walk,
  box already on a goal, all boxes on goals (empty answer), a box
  starting on the door square, a corner-trap level, a single open
  room, and an unsolvable dead-corner level (empty answer, no crash).
  All solved counts match an independent push-optimal BFS.

Run the checks (needs the unpacked kit for `gen-test` only):

```
node tools/check.mjs <input-dir> [manifest.json]
node tools/gen-test.mjs <kit-dir> <label> [<label> ...]
```

## Layout

- `main.ts` — the entry; the only file the grader runs.
- `tools/check.mjs` — runs `main.ts` twice, checks determinism,
  replays every solution with an independent simulator, compares
  push counts with a manifest's P\*.
- `tools/gen-test.mjs` — draws fresh sets with the kit generator
  and checks them.
- `tools/edge/input/` — hand-built edge levels.

## License

MIT — see `LICENSE`.
