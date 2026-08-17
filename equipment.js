// Common GMS equipment sets, keyed by the item level that matters for Star
// Force cost. Players know their gear by name ("my Absolab hat"), not by level —
// asking for a number means alt-tabbing into the game to read it, so offer the
// names and derive the level. Levels here are the real in-game equip levels;
// cost scales with level alone, so every set on a row costs the same to star.
//
// Icons are original glyphs, not game sprites: an emblem per tier, distinct in
// silhouette so the row reads at a glance even before the labels are.

(function (global) {
  // Single-path glyphs on a 24×24 grid, drawn in currentColor.
  const ICONS = {
    // Lion King's crown — Von Leon.
    crown:
      "M3 8l4 3 5-6 5 6 4-3-2 10H5L3 8zm2.6 12h12.8a1 1 0 0 1 0 2H5.6a1 1 0 0 1 0-2z",
    // Battle helm — Pensalir / Empress.
    helm: "M12 2a8 8 0 0 0-8 8v7a3 3 0 0 0 3 3h2v-6h6v6h2a3 3 0 0 0 3-3v-7a8 8 0 0 0-8-8zm-3 8a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm6 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z",
    // Cuirass — Chaos Root Abyss / Gollux.
    armor:
      "M12 2l7 3v6c0 5-3 8.6-7 11-4-2.4-7-6-7-11V5l7-3zm0 4.2L8 7.6V11c0 3.2 1.7 5.6 4 7.2 2.3-1.6 4-4 4-7.2V7.6l-4-1.4z",
    // Blade — AbsoLab / Sweetwater.
    blade:
      "M18.5 2L21 4.5 9.8 15.7l-2.5-2.5L18.5 2zM6.6 14.2l3.2 3.2-2 2-1-1-1.6 1.6a1.6 1.6 0 0 1-2.3-2.3L4.5 16l-1-1 2-2z",
    // Arcane rune — Arcane Umbra / Genesis.
    rune: "M12 1.5l3.2 5.6 6.3 1.2-4.4 4.7.8 6.4-5.9-2.7-5.9 2.7.8-6.4L2.5 8.3l6.3-1.2L12 1.5zm0 5.3L10.4 9.6l-3.1.6 2.2 2.3-.4 3.2 2.9-1.3 2.9 1.3-.4-3.2 2.2-2.3-3.1-.6L12 6.8z",
    // Eternal flame — Eternal.
    flame:
      "M12 1.6s5.6 4.3 5.6 9.6a5.6 5.6 0 0 1-11.2 0c0-1.7.6-3.3 1.4-4.7.3 1.3 1.1 2.4 2.3 2.4 1.6 0 2-1.9 1.9-7.3zM12 20a3 3 0 0 0 3-3c0-1.8-1.5-3.2-3-5.4-1.5 2.2-3 3.6-3 5.4a3 3 0 0 0 3 3z",
  };

  // Ordered low → high. `level` drives the cost formula; `sets` are the sets a
  // player would recognise at that level.
  const PRESETS = [
    { level: 120, icon: "crown", label: "Von Leon", sets: ["Von Leon", "Utgard"] },
    { level: 140, icon: "helm", label: "Pensalir", sets: ["Pensalir", "Empress"] },
    {
      level: 150,
      icon: "armor",
      label: "CRA / Gollux",
      sets: ["Chaos Root Abyss", "Superior Gollux"],
    },
    {
      level: 160,
      icon: "blade",
      label: "AbsoLab",
      sets: ["AbsoLab", "Sweetwater", "Pitched Boss"],
    },
    {
      level: 200,
      icon: "rune",
      label: "Arcane Umbra",
      sets: ["Arcane Umbra", "Genesis"],
    },
    { level: 250, icon: "flame", label: "Eternal", sets: ["Eternal"] },
  ];

  function iconSvg(name, size) {
    const d = ICONS[name];
    if (!d) return "";
    const s = size || 22;
    return (
      `<svg class="eq-icon" viewBox="0 0 24 24" width="${s}" height="${s}" ` +
      `aria-hidden="true" fill="currentColor"><path d="${d}"/></svg>`
    );
  }

  // Preset whose level matches exactly, else null (a custom level is not a set).
  function byLevel(level) {
    return PRESETS.find((p) => p.level === Number(level)) || null;
  }

  // "AbsoLab · Sweetwater · Pitched Boss"
  function setsLabel(preset) {
    return preset ? preset.sets.join(" · ") : "";
  }

  global.SF = global.SF || {};
  global.SF.equipment = { PRESETS, ICONS, iconSvg, byLevel, setsLabel };
})(window);
