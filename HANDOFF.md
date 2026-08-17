# Handoff — Star Force Calculator (Enhanced)

Working notes for picking this up on another machine or in a fresh chat.
Read this first; it's the fastest path to context.

## What this is

A fork of [AngeloTadeucci/starforcing-calc](https://github.com/AngeloTadeucci/starforcing-calc),
extended with an equipment/star-range UI overhaul and a budget planner.

- **Upstream:** `AngeloTadeucci/starforcing-calc` (added as the `upstream` remote)
- **Our branch:** `claude/review-and-continue-tqmg1u`
- **Attribution:** the footer credits upstream, MathBro/serverDiffs, StrategyWiki,
  and contributors. Upstream ships **no LICENSE file** — see "Open question" below.

## Getting running

Zero build step. No `package.json`, no dependencies, no bundler.

```bash
git clone https://github.com/wongsyu/Maplestory-Starforce-Calculator-Enhanced
cd Maplestory-Starforce-Calculator-Enhanced
git checkout claude/review-and-continue-tqmg1u
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
`window`-attached globals (it aliases `self.window = self` first) and now pulls in
`optimizer.js` as well as `rates.js`/`simulator.js`. A naive module migration
breaks the worker.

## Architecture

Plain IIFEs attaching to `window.SF`. Scripts load in dependency order from
`index.html`:

| File | Role |
|---|---|
| `rates.js` | GMS rate tables + cost coefficients. Source of truth for game numbers. |
| `equipment.js` | Level → named gear sets (AbsoLab, Arcane Umbra…) + SVG icons. |
| `simulator.js` | Core engine: `baseCost`, `costMultiplier`, `applyRateModifiers`, `simulateOnceFast`, `runTrials`, `reachableFloor`. |
| `optimizer.js` | Closed-form plan metrics, Pareto frontier search, and the sampled budget planner. |
| `cache.js` | IndexedDB store for sampled odds curves. Degrades to "just compute it". |
| `fodder.js` | Star-transfer vs raw-tapping comparison. |
| `app.js` | All DOM. ~1,500 lines. |
| `worker.js` | Off-thread `runTrials` (histogram) and `sampleIndex` (planner curves). |
| `test.html` | 89 assertions. Open in a browser; look for `FAIL`. |

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

`sampleIndex()` simulates a plan once and stores the result as a **budget-per-odds**
curve: for each boom count `S`, the budget at which each 0.5% odds rung is first
reached. **One simulation answers every budget**, which is what makes the slider
live instead of re-simulating per drag.

The transpose is load-bearing, not a detail — read `ODDS-PRECISION.md` before
touching it. Storing the obvious way round (odds at each budget) bakes in an error
proportional to the curve's steepness, worst exactly at the elbow where the
decision gets made; gridding the *bounded* axis instead caps it at half a rung
(~0.25 pt) everywhere. Measured: 0.13 pt, versus 6.7 pt for the layout it replaced.

On top of that:
- `envelopeAt/envelopeCurve` — best achievable odds across *all* candidate plans
  at each budget. The plan that wins on a tight budget is genuinely not the one
  that wins on a fat one, so the envelope (not one fixed plan) is the honest curve.
- `budgetForProb` — cheapest budget hitting a target %. A direct read per plan now
  that the curve is stored on the odds axis; the ladder's targets are all on rungs.
- `pickContenders` — which plans earn the expensive sampling pass (see below).
- `findKnee` — elbow detection (max distance from the endpoint chord). This is the
  "stop saving, start tapping" answer.

### Sampling is two-stage, and cached

`app.js → computePlanner` scans all ~24 frontier candidates at 5k trials to find
which ones top the envelope anywhere, then re-samples only those at 200k. Both
passes run in `worker.js`. The result goes to IndexedDB keyed on the config plus
`RATES_VERSION`, so a repeat question is a ~65 ms read rather than an ~8 s compute.

**If you edit `rates.js`, bump `RATES_VERSION`.** A cached curve built from old
rates is wrong, not merely stale, and the stamp is what stops it being read.

## Where things stand

Done and pushed:

- Equipment presets with names + icons (replaces the bare level dropdown)
- Star range strip in the game's 5-per-group layout, hover shows the number
- MVP / Event as radio groups instead of selects
- Budget + spares sliders, odds curve, elbow callout, budget ladder
- Spare-ceiling warning: when spares (not meso) are the binding constraint,
  unlimited budget still caps out — the curve alone just looks like it flattens
- **Trials control removed.** Sample size was a Monte Carlo knob wearing a UI
  costume; the histogram now picks its own count by star range (`autoTrials`), and
  the planner runs the two-stage pass. The odds readout still shows its ±, because
  a player is owed the precision even when the sample size isn't theirs to set.
- **Odds precision reworked** — steps 1–3 of `ODDS-PRECISION.md`. Margin of error
  on the headline odds went ±1.4 pts → ±0.2 pts.
- Tests 26 → 89

## Next up

Nothing is half-finished. The open items, in rough order of value:

1. **Tune the trial counts** (`ODDS-PRECISION.md §10.2`). 5k/200k shipped as the
   design doc's untuned starting points. 100k would still sit under the rate-data
   ceiling and would halve the ~8 s first run.
2. **Warm the cache on tab focus** rather than on the button press, so the common
   case is instant. Costs CPU for players who never open the Optimizer.
3. **Step 4 — a shipped prewarmed cache.** Deliberately deferred; same format as
   what `cache.js` already stores, so it can be added without touching the reader.
   Only worth it once real usage shows which configs are hot.
4. **Licensing** — see below. Unchanged and still the only item with a deadline
   that isn't ours to set.

The analytic DP (exact, zero sampling error) remains documented in
`ODDS-PRECISION.md §5` as the cleaner answer if sampling ever becomes a burden. It
was not needed: measured error is now well under the rate data's own uncertainty.

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
- Anything touching `rates.js` bumps `RATES_VERSION`. Cached curves are keyed on it.
- Don't put a sample size in front of the player. That was the whole point of the
  precision work; if a number is too noisy, fix the sampling, don't add a knob.
