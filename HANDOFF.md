# Handoff — Star Force Calculator (Enhanced)

Working notes for picking this up on another machine or in a fresh chat.
Read this first; it's the fastest path to context.

## What this is

A fork of [AngeloTadeucci/starforcing-calc](https://github.com/AngeloTadeucci/starforcing-calc),
extended with an equipment/star-range UI overhaul and a budget planner.

- **Upstream:** `AngeloTadeucci/starforcing-calc` (added as the `upstream` remote)
- **Our branch:** `claude/repo-access-4engky`
- **Attribution:** the footer credits upstream, MathBro/serverDiffs, StrategyWiki,
  and contributors. Upstream ships **no LICENSE file** — see "Open question" below.

## Getting running

Zero build step. No `package.json`, no dependencies, no bundler.

```bash
git clone https://github.com/wongsyu/Maplestory-Starforce-Calculator-Enhanced
cd Maplestory-Starforce-Calculator-Enhanced
git checkout claude/repo-access-4engky
python3 -m http.server 8000
# app:   http://localhost:8000/index.html
# tests: http://localhost:8000/test.html
```

To pull upstream's fixes later:

```bash
git remote add upstream https://github.com/AngeloTadeucci/starforcing-calc
git fetch upstream && git merge upstream/main
```

**Do not add a bundler casually.** `worker.js` uses `importScripts` against
`window`-attached globals (it aliases `self.window = self` first). A naive
module migration breaks the worker.

## Architecture

Plain IIFEs attaching to `window.SF`. Scripts load in dependency order from
`index.html`:

| File | Role |
|---|---|
| `rates.js` | GMS rate tables + cost coefficients. Source of truth for game numbers. |
| `equipment.js` | Level → named gear sets (AbsoLab, Arcane Umbra…) + SVG icons. |
| `simulator.js` | Core engine: `baseCost`, `costMultiplier`, `applyRateModifiers`, `simulateOnceFast`, `runTrials`, `reachableFloor`. |
| `optimizer.js` | Closed-form plan metrics, Pareto frontier search, and the sampled budget planner. |
| `fodder.js` | Star-transfer vs raw-tapping comparison. |
| `app.js` | All DOM. ~1,500 lines. |
| `worker.js` | Runs `runTrials` off the main thread. |
| `test.html` | 68 assertions. Open in a browser; look for `FAIL`. |

### Two engines, deliberately

1. **Closed form** (`optimizer.js` top half) — exact expected cost and expected
   booms, O(stars) per plan. Used to score all 16k plan combinations and pick the
   Pareto frontier. Fast enough to run on every keystroke.
2. **Monte Carlo** (`optimizer.js` bottom half) — needed only because
   P(cost ≤ B **and** booms ≤ S) is a *joint* distribution with no tidy closed
   form. Runs only on the ~24 frontier plans.

They agree by construction: both read the same
`SF.applyRateModifiers` / `costMultiplier` / `baseCost`.

### The budget planner (the main new thing)

`sampleIndex()` simulates a plan once and indexes the result: trials bucketed by
boom count, each bucket's costs sorted. Then
`P(cost ≤ B AND booms ≤ S) = Σ_{k≤S} |{costs in bucket k ≤ B}| / trials` — a
binary search per bucket. **One simulation answers every budget**, which is what
makes the slider live instead of re-simulating per drag.

On top of that:
- `envelopeAt/envelopeCurve` — best achievable odds across *all* candidate plans
  at each budget. The plan that wins on a tight budget is genuinely not the one
  that wins on a fat one, so the envelope (not one fixed plan) is the honest curve.
- `budgetForProb` — bisection inverse: cheapest budget hitting a target %.
- `findKnee` — elbow detection (max distance from the endpoint chord). This is the
  "stop saving, start tapping" answer.

## Where things stand

Done and pushed:

- Equipment presets with names + icons (replaces the bare level dropdown)
- Trials slider with margin-of-error readout — **about to be removed, see below**
- Star range strip in the game's 5-per-group layout, hover shows the number
- MVP / Event as radio groups instead of selects
- Budget + spares sliders, odds curve, elbow callout, budget ladder
- Spare-ceiling warning: when spares (not meso) are the binding constraint,
  unlimited budget still caps out — the curve alone just looks like it flattens
- Tests 26 → 68

## Next up: kill the trials parameter

**Decision made:** trials is an implementation detail leaking into the UI. Players
shouldn't tune a Monte Carlo knob. It's being replaced with precomputed data.

### The structural facts that make this tractable

Measured, not assumed — re-derive with the snippets in git history if you doubt them.

1. **Item level collapses to a scalar.**
   `baseCost = 100·round(mult · levelTier³ · (star+1)^expo / divisor + 10)`.
   Level enters *only* as `levelTier³`. Verified: rescaling a level-160 sample by
   `(tier/160)³` reproduces every other level to **0.82% worst case**, ~0.002% at
   the levels that matter. **One sample serves all item levels.**

2. **MVP and the 30%-off event never touch the random process.** They're pure
   per-star cost multipliers. If a trial stores cost split into the ≤17 band and
   the ≥18 band, all 4 MVP tiers × 2 discount states are reconstructible
   afterward. (Watch out: the safeguard premium is *not* MVP-discounted.)

3. **Only these change the actual random walk:** star catching (2), rate class
   from the event (3 — none / boom-reduction / 5-10-15 guaranteed), the per-star
   mode+safeguard plan, and the star range.

So the precompute axes are `(current, target) × rateClass × starCatching` —
roughly **270 configs** for common play, not the millions a naive cross-product
suggests.

### Measured costs

| Thing | Number |
|---|---|
| `sampleIndex`, 100k trials, 15→22 | 575 ms |
| `sampleIndex`, 1M trials, 15→22 | 4.5 s |
| Frontier size, target 22 | 93 plans (of 16,384 evaluated) |
| Frontier size, target 25 | 141 plans |
| Margin of error @ 5k trials (today) | ±1.4 pts ← the actual problem |
| Margin of error @ 100k trials | ±0.31 pts |
| Margin of error @ 1M trials | ±0.10 pts |

Build estimate at 100k trials/plan: ~54 s per config × 270 ≈ **4 hours
single-threaded**, well under an hour parallelized. At 1M it's ~31 hours — likely
not worth it, since ±0.3 pts is already far below what anyone can perceive.

### Proposed shape

Ship the **envelope**, not raw trials. Per config, a grid of
`budget (64 steps) × spares (0–8)` → `{odds, winningPlanId}`. As `Uint8` pairs
that's ~1.2 KB per config, ~320 KB raw for 270 configs, ~100 KB gzipped, lazy-loaded.

Store alongside it, for future features: overall cost quantiles (P1–P99), the boom
distribution P(booms = k), and expected cost/booms. That's the part that makes it
a reusable dataset rather than a single-purpose cache.

Live simulation stays as the fallback for anything off-table (custom levels,
unusual ranges), so coverage gaps are a speed issue, never a correctness one.

### Open items on this

- **Regeneration story.** Rates change every patch. The build script needs to be
  committed with a documented one-liner (`node tools/build-tables.js`) and the
  table needs a `ratesVersion` stamp so a stale table is detectable at runtime.
- **Coverage.** Not yet decided — "common paths" (~270 configs) vs a broad sweep
  (~1,500). Start narrow; the fallback makes this safe to widen later.
- **Alternative considered:** exact analytic DP over a discretized cost grid
  (state = star × booms, processed in increasing cost order — the chain is a DAG
  in cost because every attempt strictly increases it). Zero variance, no data
  files, covers every config. Rejected for now as delicate (grid resolution
  becomes its own approximation) but it is the theoretically cleaner answer if
  the table ever becomes a maintenance burden.

## Open question: licensing

Upstream has **no LICENSE file**, which legally means all rights reserved. GitHub's
ToS §D.5 covers forking and modifying *on GitHub*, which is what we're doing.
Hosting the result off GitHub (own VPS, Vercel) is not covered by anything.

The fix is a 30-second ask: open an issue on upstream requesting an MIT license.
Until then, keep the fork relationship and attribution visible, and don't publish
to an independent host.

## Conventions

- Comments explain **why**, not what. Match that density — it's the house style
  and upstream is consistent about it.
- Keep upstream's file layout. Every file you move becomes a permanent merge
  conflict. Add features as new files.
- Add tests to `test.html` in the existing `check(name, cond)` style.
- Design tokens live in `:root` / `:root[data-theme="light"]` in `styles.css`.
  Never hardcode a color; both themes must work.
- Canvas charts read colors via `cssVar()` and repaint on theme change — if you
  add one, hook it into `redrawHistograms()`.
