// Runs the Monte Carlo work off the main thread so the UI never blocks.
// rates.js, simulator.js and optimizer.js attach their exports to `window`; inside
// a worker the global object is `self`, so alias it before importing them.
self.window = self;
importScripts("rates.js", "simulator.js", "optimizer.js");

// Two jobs share this worker. "simulate" drives the histogram run; "sample" builds
// the planner's odds curves, which is the heavier of the two — the fine pass is
// ~200k trials per plan and would freeze the page for seconds on the main thread.
self.onmessage = function (e) {
  const msg = e.data;

  if (msg.type === "sample") {
    const indexes = [];
    for (let i = 0; i < msg.jobs.length; i++) {
      const job = msg.jobs[i];
      indexes.push(self.SF.optimizer.sampleIndex(job.input, msg.trials));
      // Blocking between jobs is harmless here, so progress is per-plan rather
      // than time-sliced — one plan is already a short enough step to report on.
      self.postMessage({ type: "progress", done: i + 1, total: msg.jobs.length });
    }
    self.postMessage({ type: "sampled", indexes: indexes });
    return;
  }

  self.SF.runTrials(msg.input, {
    // Blocking the worker thread is harmless (it isn't the UI thread), so use a
    // larger time slice than the main-thread default — fewer scheduling hops,
    // while still posting progress several times a second.
    sliceMs: 80,
    onProgress: function (done, total) {
      self.postMessage({ type: "progress", done: done, total: total });
    },
  }).then(function (stats) {
    self.postMessage({ type: "done", stats: stats });
  });
};
