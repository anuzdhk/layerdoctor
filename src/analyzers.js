/*
 * analyzers.js — pure analysis over the snapshot produced by scanner.js.
 *
 * Nothing in this file touches Photoshop. Every function takes plain data and
 * returns plain data, which keeps the rules trivially testable and means the
 * document is only ever read once (see PERFORMANCE in the README).
 */

/* ------------------------------------------------------------------ *
 * Bad-name rules
 * ------------------------------------------------------------------ */

/**
 * Deterministic, regex-driven rules. No AI, no heuristics beyond these patterns.
 * Add or edit entries here to change detection; `enabledByDefault: false` rules
 * are available but off until the user opts in (Settings, Phase 5).
 */
const BAD_NAME_RULES = [
  {
    id: "emptyName",
    label: "Blank name",
    settingLabel: "Blank names",
    enabledByDefault: true,
    pattern: /^\s*$/,
  },
  {
    id: "layerNumber",
    label: 'Default "Layer #" name',
    settingLabel: "Layer #",
    enabledByDefault: true,
    // "Layer 1", "Layer 23", "layer  7"
    pattern: /^layer\s*\d+$/i,
  },
  {
    id: "groupNumber",
    label: 'Default "Group #" name',
    settingLabel: "Group #",
    enabledByDefault: true,
    // "Group 1", "Group 12", "Layer Group 3"
    pattern: /^(layer\s+)?group\s*\d*$/i,
  },
  {
    id: "shapeDefaults",
    label: "Default shape name",
    settingLabel: "Shape defaults",
    enabledByDefault: true,
    // "Rectangle 4", "Ellipse 7", "Shape 22", "Rounded Rectangle 1", "Path"
    pattern:
      /^(rounded\s+rectangle|rectangle|ellipse|polygon|triangle|star|line|shape|path|custom\s+shape|vector\s+smart\s+object)\s*\d*$/i,
  },
  {
    id: "copyNames",
    label: 'Duplicated "copy" name',
    settingLabel: '"copy" names',
    enabledByDefault: true,
    // "Copy", "Layer 2 copy", "Layer 2 copy 4", "Hero copy 12"
    pattern: /(^|\s)copy(\s*\d+)?$/i,
  },
  {
    id: "placeholderNames",
    label: "Placeholder name",
    settingLabel: "Placeholder names",
    enabledByDefault: true,
    // "Untitled", "test", "asdf", "temp 2", "final", "aaa", "xxx", "delete me"
    pattern:
      /^(untitled|unnamed|test\s*\d*|tests|asdf+|asdfg+|qwerty|sdf+|aaa+|xxx+|zzz+|temp\s*\d*|tmp\s*\d*|new\s+layer\s*\d*|final\s*\d*|foo|bar|baz|delete(\s+me)?|todo|wip)$/i,
  },
  {
    id: "adjustmentDefaults",
    label: "Default adjustment-layer name",
    settingLabel: "Adjustment defaults",
    // Off by default: "Levels 1" / "Color Fill 1" are Photoshop defaults, but
    // plenty of people intentionally leave them, so opting in is the safer call.
    enabledByDefault: false,
    pattern:
      /^(levels|curves|exposure|vibrance|hue\/saturation|color\s+balance|black\s*&\s*white|photo\s+filter|channel\s+mixer|color\s+lookup|invert|posterize|threshold|selective\s+color|gradient\s+map|brightness\/contrast|color\s+fill|gradient\s+fill|pattern\s+fill)\s*\d*$/i,
  },
  {
    id: "singleCharacter",
    label: "Single-character name",
    settingLabel: "Single-character names",
    // Off by default: "A" / "1" can be deliberate in some naming systems.
    enabledByDefault: false,
    pattern: /^.$/,
  },
];

/** Map of rule id → boolean, with every rule at its default state. */
function defaultBadNameRuleFlags() {
  const flags = {};
  BAD_NAME_RULES.forEach((rule) => {
    flags[rule.id] = rule.enabledByDefault;
  });
  return flags;
}

/**
 * Tunable analysis settings. Phase 5 adds a Settings panel that persists
 * overrides; until then these defaults are used for every scan.
 */
const DEFAULT_SETTINGS = {
  deepNestingThreshold: 5,
  badNameRules: defaultBadNameRuleFlags(),
};

/**
 * Returns the first matching bad-name rule, or null when the name looks fine.
 * `ruleFlags` is an optional { ruleId: boolean } map; omitted means defaults.
 */
function matchBadNameRule(name, ruleFlags) {
  const flags = ruleFlags || defaultBadNameRuleFlags();
  const value = typeof name === "string" ? name.trim() : "";

  for (const rule of BAD_NAME_RULES) {
    if (!flags[rule.id]) continue;
    if (rule.pattern.test(value)) return rule;
  }
  return null;
}

/** Boolean convenience wrapper around matchBadNameRule. */
function isBadLayerName(name, ruleFlags) {
  return matchBadNameRule(name, ruleFlags) !== null;
}

/* ------------------------------------------------------------------ *
 * Individual analyzers (pure)
 * ------------------------------------------------------------------ */

/** Trim, lowercase and collapse inner whitespace so "Button" == " button ". */
function normalizeName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function findBadNames(layers, ruleFlags) {
  const flags = ruleFlags || defaultBadNameRuleFlags();
  const results = [];

  for (const layer of layers) {
    const rule = matchBadNameRule(layer.name, flags);
    if (rule) {
      results.push({ layer, ruleId: rule.id, reason: rule.label });
    }
  }
  return results;
}

/**
 * Groups layers whose normalized names collide.
 * Returns { sets, layers } where `sets` is one entry per colliding name and
 * `layers` is the flat list of every layer involved.
 */
function findDuplicateNames(layers) {
  const buckets = new Map();

  for (const layer of layers) {
    const key = normalizeName(layer.name);
    if (!key) continue; // blank names are handled by the bad-name analyzer
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(layer);
  }

  const sets = [];
  const flat = [];

  buckets.forEach((group, key) => {
    if (group.length < 2) return;
    sets.push({ key, displayName: group[0].name, count: group.length, layers: group });
    flat.push(...group);
  });

  // Biggest collisions first — they are the ones worth renaming.
  sets.sort((a, b) => b.count - a.count);
  return { sets, layers: flat };
}

function findHiddenLayers(layers) {
  return layers.filter((layer) => layer.visible === false);
}

function findLockedLayers(layers) {
  return layers.filter((layer) => layer.locked === true);
}

/* ------------------------------------------------------------------ *
 * Empty layers — deliberately conservative
 * ------------------------------------------------------------------ */

/**
 * Plain raster layers only. Modern Photoshop reports "pixel"; the legacy numeric
 * enum mapped 1 → "normal". Everything else (text, smartObject, adjustments,
 * fills, video, 3D) is never guessed about.
 */
function isPixelLayer(layer) {
  const kind = String(layer.kind || "").toLowerCase();
  return kind === "pixel" || kind === "normal";
}

/** Zero-area bounds are Photoshop's signal that a raster layer holds no pixels. */
function hasZeroArea(layer) {
  return layer.width === 0 && layer.height === 0;
}

/**
 * Layers worth asking Photoshop about (see scanner.enrichMaskInfo).
 * Kept separate from findEmptyLayers so the Photoshop round trip only covers
 * layers that could actually qualify.
 */
function findEmptyLayerCandidates(layers) {
  return layers.filter((layer) => {
    if (layer.isGroup) return layer.childCount === 0;
    return isPixelLayer(layer) && hasZeroArea(layer);
  });
}

/**
 * Emptiness is only claimed when there is positive evidence for it:
 *
 *   - empty group      → zero children
 *   - empty raster     → pixel/normal kind AND zero-area bounds AND no mask
 *
 * A layer whose mask state could not be determined is still reported (so the
 * user can look), but `safeToDelete` stays false. Locked layers are likewise
 * reported and not marked deletable. Adjustment layers, smart objects, text,
 * fills and every other kind are skipped entirely — LayerDoctor has no safe way
 * to prove those are empty, so it does not try.
 */
function findEmptyLayers(layers) {
  const results = [];

  for (const layer of layers) {
    const mask = layer.maskInfo;
    const maskUnknown = !mask || mask.unknown === true;
    const hasMask =
      !maskUnknown && (mask.hasUserMask === true || mask.hasVectorMask === true);

    if (layer.isGroup) {
      if (layer.childCount !== 0) continue;
      if (hasMask) continue; // a masked empty group may still be doing work
      results.push({
        layer,
        reason: maskUnknown
          ? "Empty group · mask state unknown"
          : "Empty group · contains no layers",
        safeToDelete: !layer.locked && !maskUnknown,
        blockedBy: layer.locked ? "locked" : maskUnknown ? "unverified" : null,
      });
      continue;
    }

    if (!isPixelLayer(layer)) continue;
    if (layer.width === null || layer.height === null) continue; // bounds unreadable
    if (!hasZeroArea(layer)) continue;
    if (hasMask) continue; // pixels are empty but the mask is real content

    results.push({
      layer,
      reason: maskUnknown
        ? "No pixel content · mask state unknown"
        : "No pixel content",
      safeToDelete: !layer.locked && !maskUnknown,
      blockedBy: layer.locked ? "locked" : maskUnknown ? "unverified" : null,
    });
  }

  return results;
}

/* ------------------------------------------------------------------ *
 * Layers you cannot see by eye
 * ------------------------------------------------------------------ */

/**
 * Layers sitting entirely outside the canvas. They render nothing, still cost
 * file size, and — unlike hidden layers — there is no indicator for them in the
 * Layers panel, so this is the one category you genuinely cannot spot manually.
 *
 * Groups are excluded because a group's bounds are derived from its children,
 * which would report the same problem twice. Zero-area layers are excluded
 * because the empty-layer analyzer already owns them.
 */
function findOffCanvasLayers(layers, docWidth, docHeight) {
  if (!docWidth || !docHeight) return [];

  return layers.filter((layer) => {
    if (layer.isGroup) return false;
    if (!layer.bounds) return false;
    if (layer.width === 0 && layer.height === 0) return false;

    const b = layer.bounds;
    if (
      b.left === null ||
      b.top === null ||
      b.right === null ||
      b.bottom === null
    ) {
      return false;
    }

    return (
      b.right <= 0 || b.bottom <= 0 || b.left >= docWidth || b.top >= docHeight
    );
  });
}

/**
 * Layers that are switched on but painted at 0% opacity. They look identical to
 * a hidden layer in the canvas while showing an open eye in the Layers panel,
 * which makes them a classic "why isn't this showing up" time sink.
 */
function findInvisibleLayers(layers) {
  return layers.filter(
    (layer) => layer.visible === true && layer.opacity === 0
  );
}

/* ------------------------------------------------------------------ *
 * Deep nesting
 * ------------------------------------------------------------------ */

/**
 * Flags groups nested deeper than `threshold` levels. Top-level layers are
 * depth 1, so with the default of 5 a group at depth 6 is flagged.
 */
function findDeeplyNestedGroups(layers, threshold) {
  const limit =
    typeof threshold === "number" && threshold > 0
      ? threshold
      : DEFAULT_SETTINGS.deepNestingThreshold;
  return layers.filter((layer) => layer.isGroup && layer.depth > limit);
}

/* ------------------------------------------------------------------ *
 * Report assembly
 * ------------------------------------------------------------------ */

/**
 * Issue metadata. `icon` is a plugin-relative SVG path rather than an emoji —
 * emoji rendering is inconsistent across UXP builds and cannot be styled.
 */
const ISSUE_META = {
  badNames: {
    icon: "icons/naming.svg",
    title: "Bad Layer Names",
    noun: "problems detected",
  },
  duplicateNames: {
    icon: "icons/duplicate.svg",
    title: "Duplicate Names",
    noun: "duplicates",
  },
  emptyLayers: {
    icon: "icons/empty.svg",
    title: "Empty Layers",
    noun: "detected",
  },
  hiddenLayers: {
    icon: "icons/hidden.svg",
    title: "Hidden Layers",
    noun: "hidden",
  },
  lockedLayers: {
    icon: "icons/locked.svg",
    title: "Locked Layers",
    noun: "locked",
  },
  deepNesting: {
    icon: "icons/nesting.svg",
    title: "Deep Nesting",
    noun: "groups",
  },
  offCanvasLayers: {
    icon: "icons/offcanvas.svg",
    title: "Off-Canvas Layers",
    noun: "outside the canvas",
  },
  invisibleLayers: {
    icon: "icons/invisible.svg",
    title: "Invisible Layers",
    noun: "at 0% opacity",
  },
};

function buildIssue(id, count, layers, extra) {
  const meta = ISSUE_META[id];
  return Object.assign(
    {
      id,
      icon: meta.icon,
      title: meta.title,
      noun: meta.noun,
      count,
      layers,
      informational: false,
    },
    extra || {}
  );
}

/**
 * Runs every Phase 2 analyzer over a snapshot.
 * `informational` issues (hidden / locked) are reported but excluded from the
 * headline issue count, because neither is a problem on its own.
 */
function analyzeSnapshot(snapshot, settings) {
  const layers = snapshot.layers;
  const config = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  const ruleFlags = config.badNameRules || defaultBadNameRuleFlags();

  const badNames = findBadNames(layers, ruleFlags);
  const duplicates = findDuplicateNames(layers);
  const empties = findEmptyLayers(layers);
  const hidden = findHiddenLayers(layers);
  const locked = findLockedLayers(layers);
  const deep = findDeeplyNestedGroups(layers, config.deepNestingThreshold);

  const issues = [
    buildIssue(
      "badNames",
      badNames.length,
      badNames.map((entry) => entry.layer),
      { findings: badNames }
    ),
    buildIssue("duplicateNames", duplicates.layers.length, duplicates.layers, {
      sets: duplicates.sets,
    }),
    buildIssue(
      "emptyLayers",
      empties.length,
      empties.map((entry) => entry.layer),
      {
        findings: empties,
        deletableCount: empties.filter((e) => e.safeToDelete).length,
      }
    ),
    buildIssue("hiddenLayers", hidden.length, hidden, { informational: true }),
    buildIssue("lockedLayers", locked.length, locked, { informational: true }),
    buildIssue("deepNesting", deep.length, deep, {
      threshold: config.deepNestingThreshold,
    }),
  ];

  const totalIssues = issues.reduce(
    (sum, issue) => (issue.informational ? sum : sum + issue.count),
    0
  );

  return { issues, totalIssues };
}

/** Console-friendly summary for debugging. */
function logReport(report) {
  console.log(
    "[LayerDoctor] Analysis: " + report.totalIssues + " issue(s) found"
  );
  report.issues.forEach((issue) => {
    console.log(
      "  " +
        issue.title +
        ": " +
        issue.count +
        (issue.informational ? " (informational)" : "") +
        (issue.count
          ? " → " + issue.layers.map((l) => l.name).join(", ")
          : "")
    );
  });
}

module.exports = {
  BAD_NAME_RULES,
  DEFAULT_SETTINGS,
  ISSUE_META,
  defaultBadNameRuleFlags,
  matchBadNameRule,
  isBadLayerName,
  normalizeName,
  findBadNames,
  findDuplicateNames,
  findEmptyLayerCandidates,
  findEmptyLayers,
  findDeeplyNestedGroups,
  findHiddenLayers,
  findLockedLayers,
  isPixelLayer,
  analyzeSnapshot,
  logReport,
};
