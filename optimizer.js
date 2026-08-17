// Per-star plan optimizer. Pure logic, no DOM. Sits on top of the engine in
// simulator.js and scores plans with the *exact* same rates/costs the Monte
// Carlo uses (SF.applyRateModifiers / costMultiplier / baseCost / boomDropStar),
// so an analytic recommendation and a simulated run agree.
//
// Expected cost and expected booms both have a closed form even though a boom
// drops the star and forces a re-climb. From star i you pay c_i per attempt;
// success (s_i) advances, maintain stays, boom (b_i) drops to d_i = dropTo(i)
// and you must climb d_i → i again. Let R_i be the expected cost of that
// re-climb. Then the expected cost and booms to clear star i once are
//     G_i  = (c_i + b_i · R_i) / s_i
//     GB_i = (b_i · (1 + RB_i)) / s_i
// with R_i = Σ_{k=d_i}^{i-1} G_k  and  RB_i = Σ_{k=d_i}^{i-1} GB_k (prefix sums).
// The run total over current → target is Σ_{i=current}^{target-1} of each. This
// is exact (matches the MC means within sampling error) and O(stars) per plan,
// so the entire 15–21 search space scores in a few milliseconds.

(function (global) {
  const SF = global.SF;
  // Stars where Enhancement Modes exist (15–21); safeguard only on 15–17.
  const PLAN_STARS = [15, 16, 17, 18, 19, 20, 21];

  // The choices the optimizer can assign to one star. On stars 15–17 the live
  // game caps the Enhancement Mode slider at 3 — Mode 4 (0% boom) was removed as
  // redundant with Safeguard, which gives the same 0% boom there — so those stars
  // expose Modes 1–3 plus a "Mode 1 + Safeguard" entry (safeguard only stacks on
  // Mode 1). Stars 18–21 have no Safeguard, so Mode 4 remains their boom-free path.
  function starOptions(star) {
    const opts = [
      { mode: 1, safeguard: false },
      { mode: 2, safeguard: false },
      { mode: 3, safeguard: false },
    ];
    if (star <= 17) opts.splice(1, 0, { mode: 1, safeguard: true });
    else opts.push({ mode: 4, safeguard: false });
    return opts;
  }

  // Enhance stars whose mode affects the run: every 15–21 star below target.
  // Stars below `current` are still included — a boom can drop the item beneath
  // the current star (21★ → 17★, 20★ → 15★) and force a re-climb through them,
  // so their mode genuinely matters even though they read as "off" in the matrix.
  function optimizableStars(targetStar) {
    return PLAN_STARS.filter((s) => s < targetStar);
  }

  // Per-star constants for stars 0..target-1 under `opts`. Honours opts.starPlan
  // exactly as the engine does, plus the 5/10/15★ guarantee (which the sim loop —
  // not applyRateModifiers — applies: cost is still paid, success is certain).
  function buildTables(targetStar, itemLevel, opts) {
    const cost = new Float64Array(targetStar);
    const succ = new Float64Array(targetStar);
    const boom = new Float64Array(targetStar);
    const dropTo = new Int32Array(targetStar);
    const ff = opts.event === "fivetenfifteen";
    for (let s = 0; s < targetStar; s++) {
      cost[s] = Math.round(
        SF.baseCost(s, itemLevel) * SF.costMultiplier(s, opts),
      );
      if (ff && (s === 5 || s === 10 || s === 15)) {
        succ[s] = 1;
        boom[s] = 0;
      } else {
        const [sc, , bm] = SF.applyRateModifiers(s, opts);
        succ[s] = sc;
        boom[s] = bm;
      }
      dropTo[s] = SF.boomDropStar(s);
    }
    return { cost, succ, boom, dropTo };
  }

  // Closed-form expected cost & booms over [current, target). prefG/prefB are
  // reused scratch buffers (length target+1) to avoid per-candidate allocation.
  function metrics(currentStar, targetStar, t, prefG, prefB) {
    const { cost, succ, boom, dropTo } = t;
    prefG[0] = 0;
    prefB[0] = 0;
    for (let i = 0; i < targetStar; i++) {
      const s = succ[i];
      const b = boom[i];
      const d = dropTo[i];
      const R = prefG[i] - prefG[d];
      const RB = prefB[i] - prefB[d];
      const G = (cost[i] + b * R) / s;
      const GB = (b * (1 + RB)) / s;
      prefG[i + 1] = prefG[i] + G;
      prefB[i + 1] = prefB[i] + GB;
    }
    return {
      expCost: prefG[targetStar] - prefG[currentStar],
      expBooms: prefB[targetStar] - prefB[currentStar],
    };
  }

  // Public: expected cost & booms for one fully-specified plan (opts.starPlan).
  function planMetrics(currentStar, targetStar, itemLevel, opts) {
    const tables = buildTables(targetStar, itemLevel, opts);
    const prefG = new Float64Array(targetStar + 1);
    const prefB = new Float64Array(targetStar + 1);
    return metrics(currentStar, targetStar, tables, prefG, prefB);
  }

  // Precompute, per optimizable star, the (cost, succ, boom) triple for each of
  // its mode choices — once, instead of 16k+ times inside the enumeration loop.
  function optionTriples(stars, itemLevel, baseOpts) {
    const ff = baseOpts.event === "fivetenfifteen";
    return stars.map((star) => {
      const guaranteed = ff && star === 15;
      return starOptions(star).map((choice) => {
        const opts = Object.assign({}, baseOpts, { starPlan: { [star]: choice } });
        const cost = Math.round(
          SF.baseCost(star, itemLevel) * SF.costMultiplier(star, opts),
        );
        let succ, boom;
        if (guaranteed) {
          succ = 1;
          boom = 0;
        } else {
          const [s, , b] = SF.applyRateModifiers(star, opts);
          succ = s;
          boom = b;
        }
        return { choice, cost, succ, boom };
      });
    });
  }

  // Enumerate every per-star mode combination (mixed-radix over the option
  // lists), patch the optimizable stars into a shared table, score it, and hand
  // the result to `visit(choices, metricsResult)`. Invariant stars (< 15, ≥ 22,
  // and the baseline fill) are computed once.
  function enumerate(currentStar, targetStar, itemLevel, baseOpts, visit) {
    const stars = optimizableStars(targetStar);
    // Baseline with no plan and no global mode, so any enhance star we don't
    // overwrite stays vanilla (all optimizable stars are overwritten anyway).
    const base = Object.assign({}, baseOpts, { starPlan: null, enhanceMode: 0 });
    const tables = buildTables(targetStar, itemLevel, base);
    const { cost, succ, boom } = tables;
    const triples = optionTriples(stars, itemLevel, baseOpts);
    const radices = triples.map((o) => o.length);
    let total = 1;
    for (const r of radices) total *= r;

    const prefG = new Float64Array(targetStar + 1);
    const prefB = new Float64Array(targetStar + 1);

    for (let idx = 0; idx < total; idx++) {
      let n = idx;
      const choices = new Array(stars.length);
      for (let j = 0; j < stars.length; j++) {
        const r = radices[j];
        const o = triples[j][n % r];
        n = (n - (n % r)) / r;
        const star = stars[j];
        cost[star] = o.cost;
        succ[star] = o.succ;
        boom[star] = o.boom;
        choices[j] = o.choice;
      }
      visit(stars, choices, metrics(currentStar, targetStar, tables, prefG, prefB));
    }
    return { stars, total };
  }

  // Assemble a full plan ({15:{mode,safeguard}, …, 21:{…}}) from a choice list.
  // Stars not optimized (≥ target) default to Mode 1 / no safeguard.
  function planFromChoices(stars, choices) {
    const plan = {};
    PLAN_STARS.forEach((s) => (plan[s] = { mode: 1, safeguard: false }));
    stars.forEach((s, j) => {
      plan[s] = { mode: choices[j].mode, safeguard: !!choices[j].safeguard };
    });
    return plan;
  }

  // For "best odds" we need the joint distribution of (cost, booms), which has no
  // tidy closed form — so we Monte-Carlo, but only a handful of candidates. The
  // mean-(cost, booms) Pareto frontier holds the plans worth simulating: lowering
  // either mean can only help P(cost ≤ budget AND booms ≤ spares). Returns those
  // candidate plans (capped, sampled evenly) for the caller to simulate.
  function optimizeFrontier(params, maxCandidates) {
    const { currentStar, targetStar, itemLevel, opts } = params;
    if (optimizableStars(targetStar).length === 0) return { empty: true };
    const cap = maxCandidates || 24;

    const all = [];
    enumerate(currentStar, targetStar, itemLevel, opts, (stars, choices, m) => {
      all.push({ choices: choices.slice(), expCost: m.expCost, expBooms: m.expBooms });
    });
    let stars = optimizableStars(targetStar);

    // Pareto-min on (expCost, expBooms): sort by cost, keep strictly-lower booms.
    all.sort((a, b) => a.expCost - b.expCost || a.expBooms - b.expBooms);
    const frontier = [];
    let minBooms = Infinity;
    for (const c of all) {
      if (c.expBooms < minBooms - 1e-9) {
        frontier.push(c);
        minBooms = c.expBooms;
      }
    }

    let picked = frontier;
    if (frontier.length > cap) {
      picked = [];
      const step = (frontier.length - 1) / (cap - 1);
      for (let i = 0; i < cap; i++) picked.push(frontier[Math.round(i * step)]);
    }

    return {
      candidates: picked.map((c) => ({
        plan: planFromChoices(stars, c.choices),
        expCost: c.expCost,
        expBooms: c.expBooms,
      })),
      frontierSize: frontier.length,
      evaluated: all.length,
    };
  }

  function planOpts(input) {
    return {
      starCatching: !!input.starCatching,
      safeguard: !!input.safeguard,
      mvp: input.mvp || "none",
      event: input.event || "none",
      enhanceMode: input.enhanceMode || 0,
      starPlan: input.starPlan || null,
    };
  }

  // Monte-Carlo P(total cost ≤ budget AND booms ≤ spares) for one plan, reusing
  // the same fast trial kernel the main simulation uses.
  function successProb(input, budgetMesos, spares, trials) {
    const tables = SF.buildStarTables(
      input.targetStar,
      input.itemLevel,
      planOpts(input),
    );
    let ok = 0;
    for (let i = 0; i < trials; i++) {
      const t = SF.simulateOnceFast(input.currentStar, input.targetStar, tables);
      if (t.totalCost <= budgetMesos && t.booms <= spares) ok++;
    }
    return ok / trials;
  }

  // ── Budget planning ─────────────────────────────────────────────────────
  // successProb() answers one (budget, spares) question per simulation, which is
  // fine for a button but hopeless behind a slider. Instead sample the *joint*
  // (cost, booms) distribution once and keep it, so every budget the player can
  // drag to is a lookup rather than a fresh simulation.
  //
  // The sample is stored **transposed**: not "odds at each budget" but "budget at
  // each odds level", on a fixed grid of 0.5% rungs. That choice carries the whole
  // accuracy story, so it's worth stating why.
  //
  // Keeping a sample at all means gridding some axis and interpolating between
  // the grid points. Grid the *budget* axis evenly and the interpolation error is
  // proportional to how steep the curve is between two points — and this curve is
  // near-vertical exactly at the elbow, where the save-or-tap decision is made. A
  // 64-step grid over a 0–79B range misses by up to 6.7 points there, five times
  // the ±1.4 pt sampling noise it would be meant to fix, and no number of trials
  // shrinks it.
  //
  // Transposing removes that error rather than correcting it. Probability is
  // bounded to [0, 1], so an even grid on *that* axis is complete, and the worst
  // interpolation error is half a rung — ~0.25 points, everywhere, whatever the
  // curve does. Equal steps in odds map to tiny steps in budget wherever the curve
  // is steep, so resolution bunches up at the elbow for free. It also makes the
  // question players actually ask ("what budget gets me to 90%?") a direct read,
  // since 90% is itself a rung.

  // 0.5% rungs: 0%, 0.5%, … 100%. Half a rung (~0.25 pt) is already well under the
  // ±0.5 pt uncertainty in the community-measured rates themselves, so a finer
  // grid would only compute a wrong number more precisely.
  const ODDS_STEP = 0.005;
  const ODDS_RUNGS = 201;

  // Turn raw (cost, booms) trial results into the transposed grid. Split out from
  // sampleIndex so the layout can be tested against hand-built samples.
  //
  // Rows are nested by construction — the runs that stay within S booms are a
  // subset of those within S+1 — so the union is built incrementally by merging
  // one boom bucket in at a time, rather than re-sorting per spare count.
  function indexSample(costs, booms, maxBooms, trials) {
    const counts = new Int32Array(maxBooms + 1);
    for (let i = 0; i < trials; i++) counts[booms[i]]++;
    const byBooms = [];
    for (let k = 0; k <= maxBooms; k++) byBooms.push(new Float64Array(counts[k]));
    const fill = new Int32Array(maxBooms + 1);
    for (let i = 0; i < trials; i++) {
      const k = booms[i];
      byBooms[k][fill[k]++] = costs[i];
    }
    // Comparator-free sort on a typed array: numeric ascending, and fast.
    byBooms.forEach((b) => b.sort());

    const curves = [];
    const ceilings = new Float64Array(maxBooms + 1);
    const tails = new Float64Array(maxBooms + 1);
    // The running union of buckets 0..S, and a scratch buffer to merge into.
    let cum = new Float64Array(trials);
    let scratch = new Float64Array(trials);
    let cumLen = 0;

    for (let S = 0; S <= maxBooms; S++) {
      const add = byBooms[S];
      let i = 0;
      let j = 0;
      let o = 0;
      while (i < cumLen && j < add.length)
        scratch[o++] = cum[i] <= add[j] ? cum[i++] : add[j++];
      while (i < cumLen) scratch[o++] = cum[i++];
      while (j < add.length) scratch[o++] = add[j++];
      const swap = cum;
      cum = scratch;
      scratch = swap;
      cumLen = o;

      const row = new Float64Array(ODDS_RUNGS).fill(Infinity);
      // Rung 0 anchors the curve at probability zero: the cheapest run that stays
      // within S booms. No budget below it finishes at all.
      row[0] = cumLen ? cum[0] : Infinity;
      for (let r = 1; r < ODDS_RUNGS; r++) {
        const need = Math.ceil(r * ODDS_STEP * trials);
        // Odds above P(booms ≤ S) are unreachable at any budget; those rungs stay
        // Infinity and `ceilings` records where the curve actually stops.
        if (need > cumLen) break;
        row[r] = cum[need - 1];
      }
      curves.push(row);
      ceilings[S] = cumLen / trials;
      tails[S] = cumLen ? cum[cumLen - 1] : Infinity;
    }

    return {
      trials,
      maxBooms,
      step: ODDS_STEP,
      rungs: ODDS_RUNGS,
      curves,
      ceilings,
      tails,
      minCost: curves[maxBooms][0],
    };
  }

  // Sample a plan and index it in one pass.
  function sampleIndex(input, trials) {
    const tables = SF.buildStarTables(
      input.targetStar,
      input.itemLevel,
      planOpts(input),
    );
    const costs = new Float64Array(trials);
    const booms = new Int32Array(trials);
    let maxBooms = 0;
    for (let i = 0; i < trials; i++) {
      const t = SF.simulateOnceFast(input.currentStar, input.targetStar, tables);
      costs[i] = t.totalCost;
      booms[i] = t.booms;
      if (t.booms > maxBooms) maxBooms = t.booms;
    }
    return indexSample(costs, booms, maxBooms, trials);
  }

  // Odds at a budget — reading the transposed curve back. Lands on a rung and
  // it's a direct read; between rungs it interpolates, which is where the ~0.25 pt
  // worst case lives.
  function probAt(index, budget, spares) {
    const S = Math.min(spares, index.maxBooms);
    const row = index.curves[S];
    const ceiling = index.ceilings[S];
    // Also catches NaN and the all-Infinity row of a spare count that never finishes.
    if (!(budget >= row[0])) return 0;

    // Highest rung this budget affords. Rungs past the ceiling hold Infinity, which
    // compares false against any finite budget, so the search stops there by itself.
    let lo = 0;
    let hi = index.rungs - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (row[mid] <= budget) lo = mid;
      else hi = mid - 1;
    }

    const p = lo * index.step;
    if (p >= ceiling) return ceiling;
    // Interpolate toward the next rung — or toward the ceiling itself, when this is
    // the last rung the sample reached and the remainder is a partial step.
    const nextP = Math.min(p + index.step, ceiling);
    const nextB =
      lo + 1 < index.rungs && row[lo + 1] < Infinity ? row[lo + 1] : index.tails[S];
    if (!(nextB > row[lo])) return nextP;
    return Math.min(
      p + ((budget - row[lo]) / (nextB - row[lo])) * (nextP - p),
      ceiling,
    );
  }

  // The budget one plan needs to reach `prob` — the read the transposed layout
  // exists for. Infinity when spares, not meso, are the binding constraint.
  function budgetAt(index, prob, spares) {
    const S = Math.min(spares, index.maxBooms);
    if (prob > index.ceilings[S] + 1e-12) return Infinity;
    const row = index.curves[S];
    const x = Math.max(0, Math.min(index.rungs - 1, prob / index.step));
    const r = Math.floor(x);
    if (row[r] === Infinity) return Infinity;
    if (r >= index.rungs - 1) return row[index.rungs - 1];
    const at = row[r];
    const next = row[r + 1] < Infinity ? row[r + 1] : index.tails[S];
    return at + (x - r) * (next - at);
  }

  // Cost quantile ignoring booms: the q-th rung of the unlimited-spares row.
  function quantile(index, q) {
    const row = index.curves[index.maxBooms];
    const r = Math.min(index.rungs - 1, Math.max(0, Math.round(q / index.step)));
    return row[r];
  }

  // Best achievable odds at (budget, spares) across every candidate plan, plus
  // which plan gets you there. The player's real question is "what can this much
  // meso buy me", not "how does one fixed plan fare" — and the best plan for a
  // tight budget is genuinely not the best plan for a fat one (a cheap high-boom
  // line wins when you can't afford safeguard, and loses when you can).
  function envelopeAt(indexed, budget, spares) {
    let best = null;
    for (let i = 0; i < indexed.length; i++) {
      const p = probAt(indexed[i].index, budget, spares);
      if (!best || p > best.prob + 1e-12) best = { prob: p, cand: indexed[i], i };
    }
    return best;
  }

  // The envelope sampled across a budget range — the curve the planner draws.
  function envelopeCurve(indexed, spares, budgets) {
    return budgets.map((b) => {
      const e = envelopeAt(indexed, b, spares);
      return { budget: b, prob: e ? e.prob : 0, planIdx: e ? e.i : -1 };
    });
  }

  // Cheapest budget that still reaches `target` odds anywhere on the envelope.
  // The envelope reaches the target exactly when its cheapest plan does, so this
  // is a min over direct reads — the bisection the old budget-keyed layout needed
  // is gone, and so is its tolerance. null means no budget gets there: spares are
  // the binding constraint.
  function budgetForProb(indexed, spares, target) {
    let best = Infinity;
    for (let i = 0; i < indexed.length; i++) {
      const b = budgetAt(indexed[i].index, target, spares);
      if (b < best) best = b;
    }
    return best < Infinity ? best : null;
  }

  // Which plans deserve the expensive sampling pass. Only a plan that tops the
  // envelope somewhere is ever shown, so precision spent on the rest buys nothing
  // — typically 3–6 of the ~24 candidates matter. Sampling everything to the same
  // depth is brute force; this is the same precision aimed better.
  //
  // The catch is that the cheap pass used to pick winners is itself noisy, so a
  // strict argmax would sometimes drop a real winner over sampling scatter. Plans
  // within `margin` of the leader are kept too. Outright winners are never
  // dropped; only the near-misses compete for the remaining slots.
  function pickContenders(indexed, budgets, sparesList, margin, cap) {
    const n = indexed.length;
    const wins = new Int32Array(n);
    // Best shortfall against the leader across the grid: 0 where a plan led.
    const closeness = new Float64Array(n).fill(-Infinity);
    const probs = new Float64Array(n);

    for (let si = 0; si < sparesList.length; si++) {
      for (let bi = 0; bi < budgets.length; bi++) {
        let best = -1;
        let bestI = -1;
        for (let i = 0; i < n; i++) {
          const p = probAt(indexed[i].index, budgets[bi], sparesList[si]);
          probs[i] = p;
          if (p > best) {
            best = p;
            bestI = i;
          }
        }
        // A budget nothing can finish on ranks every plan equally at zero; it says
        // nothing about which plan is better, so it gets no vote.
        if (best <= 0) continue;
        wins[bestI]++;
        for (let i = 0; i < n; i++)
          if (probs[i] - best > closeness[i]) closeness[i] = probs[i] - best;
      }
    }

    const order = [];
    for (let i = 0; i < n; i++) order.push(i);
    order.sort((a, b) => wins[b] - wins[a] || closeness[b] - closeness[a]);
    const winners = order.filter((i) => wins[i] > 0);
    const near = order.filter((i) => wins[i] === 0 && closeness[i] >= -margin);
    const kept = winners.concat(near.slice(0, Math.max(0, cap - winners.length)));
    // Degenerate grids (every budget below the cheapest run) leave nobody standing;
    // fall back to the cheapest plan so the planner still has something to show.
    if (kept.length === 0 && n) kept.push(0);
    return {
      keep: kept.sort((a, b) => a - b),
      winners: winners.length,
      dropped: n - kept.length,
    };
  }

  // Diminishing-returns point: the curve point furthest from the straight chord
  // joining its ends (the standard "elbow" construction). On a concave rising
  // curve that is exactly where the steep early gains flatten out — past it each
  // extra billion buys measurably less probability, which is the moment the
  // player stops saving and starts tapping. Axes are normalised first so the
  // answer doesn't depend on whether cost is read in mesos or billions.
  function findKnee(points) {
    if (points.length < 3) return null;
    const x0 = points[0].budget;
    const y0 = points[0].prob;
    const x1 = points[points.length - 1].budget;
    const y1 = points[points.length - 1].prob;
    const dx = x1 - x0;
    const dy = y1 - y0;
    if (dx <= 0 || Math.abs(dy) < 1e-9) return null;

    let best = null;
    for (let i = 1; i < points.length - 1; i++) {
      const nx = (points[i].budget - x0) / dx;
      const ny = (points[i].prob - y0) / dy;
      // Perpendicular offset from the unit chord, in normalised space.
      const dist = ny - nx;
      if (!best || dist > best.dist) best = { dist, point: points[i], i };
    }
    // A dead-straight or convex curve has no meaningful elbow to report.
    return best && best.dist > 0.02 ? best : null;
  }

  SF.optimizer = {
    PLAN_STARS,
    starOptions,
    optimizableStars,
    planMetrics,
    optimizeFrontier,
    successProb,
    indexSample,
    sampleIndex,
    probAt,
    budgetAt,
    quantile,
    ODDS_STEP,
    ODDS_RUNGS,
    envelopeAt,
    envelopeCurve,
    budgetForProb,
    pickContenders,
    findKnee,
  };
})(window);
