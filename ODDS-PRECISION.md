# Odds precision: why the trials slider goes away, and what replaces it

Design note. Written after measuring, not before — one of the conclusions
reverses an earlier proposal in this document's own history, and the measurement
that caused it is reproduced below so the reversal can be checked.

**Status:** analysis complete, implementation not started.

---

## 1. The problem

The Optimizer exposes a **Trials** control. It is a Monte Carlo tuning knob
wearing a UI costume. Players should not have to reason about sample sizes to
find out whether to keep saving.

Worse, the default is not actually good enough. At the current 5,000 trials the
95% confidence half-width on a probability is

```
1.96 · sqrt(0.25 / 5000) = ±1.4 percentage points
```

So the headline "72.3% chance" is really "somewhere around 71–74%", and
re-running visibly moves it. For a tool whose entire job is to make a
save-or-tap decision legible, that wobble is the product's core defect, not a
detail.

**Goal:** remove the control, and make the number stable enough that re-running
never changes the decision.

---

## 2. What actually needs computing

Most of the parameter space does not need simulating at all. Measured, not
assumed.

### 2.1 Item level collapses to a multiply

```js
baseCost = 100 · round( mult · levelTier³ · (star+1)^expo / divisor + 10 )
```

Level enters **only** as `levelTier³`. Rescaling a level-160 sample by
`(tier/160)³` reproduces other levels with this error:

| Level | Range | Aggregate error | Worst single star |
|---|---|---|---|
| 120 | 0→22 | 0.003% | 0.820% |
| 120 | 15→22 | 0.001% | 0.004% |
| 200 | 15→22 | 0.0004% | 0.001% |
| 250 | 15→22 | 0.0006% | 0.002% |
| 250 | 17→23 | 0.0005% | 0.001% |

The 0.82% worst case is entirely at **star 0**, where an attempt costs a few
thousand mesos and contributes nothing to a real climb. Weighted by actual cost
contribution the error is ~0.001%.

**One sample serves every item level, custom levels included.**

### 2.2 MVP and the cost event never touch the random walk

`costMultiplier` applies MVP (stars ≤17 only) and the 30%-off event as pure
per-star multipliers. They change what a run *costs*, never what it *does*.

Store each trial's cost split into the ≤17 band and the ≥18 band, and all
4 MVP tiers × 2 discount states reconstruct exactly afterward.

> Caveat: the safeguard premium is **not** MVP-discounted. See the comments in
> `simulator.js → costMultiplier`, which record in-game verification.

### 2.3 What's left

Only these change the actual random process:

- star catching (2)
- rate class from the event (3 — none / boom-reduction / 5-10-15 guaranteed)
- the per-star mode + safeguard plan
- the star range

---

## 3. The wrong turn

The first proposal was to precompute a shipped lookup table: per config, a
**64-step budget × 9-spare grid** of odds, ~100 KB gzipped, with high trial
counts run offline where they're affordable.

That proposal was wrong, and the measurement that kills it is simple — how much
does the curve move across one grid step?

```
budget range 0..79B, 64 steps = 1.2B per step
steepest single step: 6.7 pts
```

**Nearly 7 percentage points of quantization error.** Almost five times worse than
the ±1.4 pt sampling error the whole exercise was meant to fix.

The error is worst precisely where users care most: the steep early part of the
curve, where the elbow lives and where a budget decision is actually made.
Running 100k trials on top of that grid would have been effort spent making a
rounding error very precise.

**Lesson: the representation was the dominant error term, not the trial count.**

---

## 4. The fix: store the inverse

Do not store `odds` at each budget. Store **`budget` at each odds level**.

Probability is bounded to [0, 1]; budget is not. Sampling the probability axis
uniformly puts resolution where the curve is steep, automatically:

| | Budget grid (rejected) | Probability grid (proposed) |
|---|---|---|
| Axis sampled | budget, 64 steps | odds, 0.5% steps |
| Interpolation error | proportional to curve steepness — **6.7 pts** at worst | fixed **~0.25 pts** by construction |
| Worst case sits | exactly at the elbow | nowhere in particular |
| Ladder query ("budget for 90%?") | bisection search | direct read |

The quantity stored per (config, plan, spare count) is the inverse CDF: the
budget at which each probability level is first reached.

---

## 5. Recommended plan

In dependency order. Each step is independently valuable.

### Step 1 — Fix the representation

Change how `sampleIndex` stores its output: quantiles on the probability axis
instead of raw sorted costs queried at arbitrary budgets.

No data files, no build step, no download. **Largest accuracy win of the four,
and the cheapest.**

### Step 2 — Two-stage sampling

Precision is only needed on plans that actually *win* somewhere on the envelope
— typically 3–6 of the ~24 candidates.

1. Cheap pass: 5k trials × all candidates → identify the winners
2. Expensive pass: 200k trials × winners only

Roughly 6 s in a worker, versus ~14 s for a uniform 100k pass over everything,
and more precise where it counts.

### Step 3 — Cache to IndexedDB, keyed by config

Second time the same question is asked, it is instant. This is
"compute once, retrieve forever" — just per-user rather than shipped.

### Step 4 — *Optionally*, ship a prewarmed cache

A file covering common configs, in the same format as step 3, so even a first
run is instant. Since the rates are stable patch to patch, this will not rot.

**Steps 1–3 have no coverage gaps** — custom item levels and unusual star
ranges work identically. Step 4 is a pure speed optimisation, and only earns its
keep once real usage shows which configs are hot.

### Why not a shipped table as the foundation

It was the original plan. Against it:

- grid error (§3) unless the representation is fixed first — and once it *is*
  fixed, on-demand computation is accurate enough that the table buys only speed
- coverage gaps requiring a live-simulation fallback anyway
- a download, a build script, and a regeneration story to maintain
- it cannot answer a question that wasn't enumerated at build time

### Why not exact analytic DP

Considered: DP over a discretised cost grid, state `(star, booms)`, processed in
increasing cost order — the chain is a DAG in cost because every attempt
strictly increases it, so no fixed-point iteration is needed. Zero sampling
error, no data files, every config covered.

Set aside because grid resolution becomes its own approximation (per-attempt
costs at low stars are smaller than a sensible bin width, so mass has to be
interpolated across bins and the error accumulates over ~100 attempts), and
because §6 caps the useful precision well above what the DP would deliver. It
remains the theoretically cleanest answer if the sampling approach ever becomes
a burden.

---

## 6. The accuracy ceiling is the rate data, not the math

After steps 1–2 the numerical error is about **±0.3 pt**, far past the point of
changing a save-or-tap decision.

But `rates.js` carries values like

```js
21: [0.15, 0.7225, 0.1275],   // success / maintain / boom
```

sourced from community measurement (`serverDiffs.js` via MathBro), not from
Nexon. If those are off by even half a percent, the error flows straight through
and swamps anything numerical.

**Precision below ~±0.5 pt is false comfort** — a wrong number computed very
precisely. This is the main argument for stopping at step 3 and not building
infrastructure for a precision the inputs cannot support.

---

## 7. Reference measurements

Machine-dependent timings; ratios are the durable part.

| Measurement | Value |
|---|---|
| `sampleIndex`, 100k trials, 15→22 | 575 ms |
| `sampleIndex`, 1M trials, 15→22 | 4,513 ms |
| Frontier size, target 22 | 93 plans (16,384 evaluated) |
| Frontier size, target 25 | 141 plans |
| Margin of error @ 5k trials (**current default**) | **±1.4 pts** |
| @ 100k trials | ±0.31 pts |
| @ 1M trials | ±0.10 pts |
| 64-step budget grid, steepest step | **~6.7 pts** (6.7–6.8 across runs) |
| Level³ rescaling, weighted | ~0.001% |

Margin of error is the 95% half-width at its widest (p = 0.5):
`1.96 · sqrt(0.25 / n)`.

### Reproducing

From the repo root, with Node:

```bash
# Level rescaling error, weighted by real cost contribution
node -e '
global.window = global;
require("./rates.js"); require("./simulator.js"); require("./optimizer.js");
const C = global.COST_COEFS;
const baseCost = (s, lv) => { const c = C[s], t = Math.floor(lv/10)*10;
  return 100*Math.round((c.mult*Math.pow(t,3)*Math.pow(s+1,c.expo))/c.divisor + 10); };
for (const lv of [120,150,200,250]) {
  let num = 0, den = 0;
  for (let s = 15; s < 22; s++) {
    const pred = baseCost(s,160)*Math.pow(Math.floor(lv/10)*10/160,3);
    num += Math.abs(pred - baseCost(s,lv)); den += baseCost(s,lv);
  }
  console.log(`lv${lv} 15->22:`, (num/den*100).toExponential(1) + "%");
}'
```

```bash
# Curve steepness across a 64-step budget grid
node -e '
global.window = global;
require("./rates.js"); require("./simulator.js"); require("./optimizer.js");
const SF = global.SF;
const idx = SF.optimizer.sampleIndex({currentStar:15, targetStar:22, itemLevel:160,
  mvp:"none", event:"none", starCatching:true, safeguard:false, starPlan:null}, 300000);
const hi = SF.optimizer.quantile(idx, 0.995), step = hi/64;
let max = 0;
for (let i = 0; i < 64; i++)
  max = Math.max(max, (SF.optimizer.probAt(idx,(i+1)*step,1)
                     - SF.optimizer.probAt(idx,i*step,1))*100);
console.log("steepest step:", max.toFixed(1), "pts over", (step/1e9).toFixed(1)+"B");'
```

---

## 8. Open decisions

1. **Proceed with steps 1–3?** Contained change to `optimizer.js` plus a cache
   layer. Removes the trials control.
2. **Step 4 at all?** Deferred by design — revisit once usage shows hot configs.
3. **Trial counts.** 5k coarse / 200k fine are starting points, not tuned.
4. **Cache invalidation.** Keying on a config hash is straightforward; the hash
   must include a `ratesVersion` so editing `rates.js` invalidates old entries.
   Cheap insurance even though rates are stable.
