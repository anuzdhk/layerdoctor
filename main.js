/*
 * main.js — LayerDoctor panel controller.
 *
 * Responsibilities are deliberately split:
 *   src/scanner.js    reads Photoshop into a snapshot
 *   src/analyzers.js  pure analysis over the snapshot
 *   src/scoring.js    pure health-score arithmetic
 *   src/fixers.js     the only module that modifies the document
 *   src/settings.js   local preference storage
 *   main.js           owns panel state and DOM rendering
 *
 * Phase 5 scope: settings (persisted locally), the batchPlay fast-scan path and
 * hardened error handling on top of the Phase 4 fix tools.
 */

const scanner = require("./src/scanner.js");
const analyzers = require("./src/analyzers.js");
const scoring = require("./src/scoring.js");
const fixers = require("./src/fixers.js");
const settingsStore = require("./src/settings.js");
const { action } = require("photoshop");

/** Panel state machine. */
const STATE = {
  NO_DOC: "no-doc",
  READY: "ready",
  SCANNING: "scanning",
  RESULTS: "results",
  DETAIL: "detail",
  RENAME: "rename",
  CONFIRM: "confirm",
  SETTINGS: "settings",
  BUSY: "busy",
};

/** States where the bottom scan button makes no sense. */
const HIDE_SCAN_IN = [
  STATE.DETAIL,
  STATE.RENAME,
  STATE.CONFIRM,
  STATE.SETTINGS,
  STATE.BUSY,
];

/** Persisted user settings, loaded once at startup. */
let settings = settingsStore.defaults();

/** The document is scanned once; everything below reads these objects. */
let lastSnapshot = null;
let lastReport = null;
let lastHealth = null;
let isScanning = false;
let currentState = STATE.NO_DOC;

/** Issue ids ticked for Fix Selected. */
const selectedIssues = new Set();

/** Rename tool working state. */
const renameState = { scope: "badNames", strategy: "type", plan: [] };

/** Pending confirmation resolver (see askConfirm). */
let confirmResolver = null;
let stateBeforeConfirm = STATE.RESULTS;

const els = {};

function cacheElements() {
  els.notice = document.getElementById("notice");
  els.states = {
    [STATE.NO_DOC]: document.getElementById("state-no-doc"),
    [STATE.READY]: document.getElementById("state-ready"),
    [STATE.SCANNING]: document.getElementById("state-scanning"),
    [STATE.RESULTS]: document.getElementById("state-results"),
    [STATE.DETAIL]: document.getElementById("state-detail"),
    [STATE.RENAME]: document.getElementById("state-rename"),
    [STATE.CONFIRM]: document.getElementById("state-confirm"),
    [STATE.SETTINGS]: document.getElementById("state-settings"),
    [STATE.BUSY]: document.getElementById("state-busy"),
  };
  els.readyDocName = document.getElementById("ready-doc-name");
  els.healthCard = document.getElementById("health-card");
  els.healthValue = document.getElementById("health-value");
  els.healthStatus = document.getElementById("health-status");
  els.healthSub = document.getElementById("health-sub");
  els.issueList = document.getElementById("issue-list");
  els.fixSelected = document.getElementById("btn-fix-selected");
  els.fixHint = document.getElementById("fix-hint");
  els.statsList = document.getElementById("stats-list");
  els.breakdownCard = document.getElementById("breakdown-card");
  els.breakdownList = document.getElementById("breakdown-list");
  els.treePreview = document.getElementById("tree-preview");
  els.scanMeta = document.getElementById("scan-meta");

  els.detailIcon = document.getElementById("detail-icon");
  els.detailTitle = document.getElementById("detail-title");
  els.detailNote = document.getElementById("detail-note");
  els.detailActions = document.getElementById("detail-actions");
  els.detailCount = document.getElementById("detail-count");
  els.detailList = document.getElementById("detail-list");
  els.backButton = document.getElementById("btn-back");

  els.renameScope = document.getElementById("rename-scope");
  els.renameScopeHint = document.getElementById("rename-scope-hint");
  els.renameStrategy = document.getElementById("rename-strategy");
  els.fieldPrefix = document.getElementById("field-prefix");
  els.fieldFind = document.getElementById("field-find");
  els.inputPrefix = document.getElementById("input-prefix");
  els.inputFind = document.getElementById("input-find");
  els.inputReplace = document.getElementById("input-replace");
  els.renamePreview = document.getElementById("rename-preview");
  els.renamePreviewCount = document.getElementById("rename-preview-count");
  els.renameApply = document.getElementById("btn-rename-apply");
  els.renameCancel = document.getElementById("btn-rename-cancel");
  els.renameBack = document.getElementById("btn-rename-back");

  els.confirmTitle = document.getElementById("confirm-title");
  els.confirmMessage = document.getElementById("confirm-message");
  els.confirmList = document.getElementById("confirm-list");
  els.confirmOk = document.getElementById("btn-confirm-ok");
  els.confirmCancel = document.getElementById("btn-confirm-cancel");

  els.reloadButton = document.getElementById("btn-reload");
  els.settingsButton = document.getElementById("btn-settings");
  els.settingsBack = document.getElementById("btn-settings-back");
  els.settingsSave = document.getElementById("btn-settings-save");
  els.settingsReset = document.getElementById("btn-settings-reset");
  els.inputThreshold = document.getElementById("input-threshold");
  els.settingsRules = document.getElementById("settings-rules");
  els.settingsPerformance = document.getElementById("settings-performance");

  els.busyTitle = document.getElementById("busy-title");
  els.scanButton = document.getElementById("btn-scan");
  els.actions = els.scanButton.parentNode;
}

/* ------------------------------------------------------------------ *
 * Small DOM helpers
 * ------------------------------------------------------------------ */

/** UXP's classList.toggle does not reliably honour the second `force` argument. */
function setHidden(element, hidden) {
  if (hidden) element.classList.add("hidden");
  else element.classList.remove("hidden");
}

function removeChildren(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
}

function makeEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
}

/** SVG icons are loaded as <img>, which UXP renders reliably at any size. */
function makeIcon(src, className) {
  const img = document.createElement("img");
  img.className = className || "icon";
  img.src = src;
  return img;
}

/** Lets the panel repaint before a blocking Photoshop call. */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function getIssue(id) {
  return lastReport ? lastReport.issues.find((issue) => issue.id === id) : null;
}

/* ------------------------------------------------------------------ *
 * State + notices
 * ------------------------------------------------------------------ */

function setState(state) {
  currentState = state;
  Object.keys(els.states).forEach((key) => {
    setHidden(els.states[key], key !== state);
  });

  setHidden(els.actions, HIDE_SCAN_IN.indexOf(state) !== -1);

  els.reloadButton.disabled =
    state === STATE.SCANNING ||
    state === STATE.BUSY ||
    state === STATE.CONFIRM ||
    state === STATE.NO_DOC;
  els.scanButton.disabled = state === STATE.SCANNING || state === STATE.NO_DOC;
  els.scanButton.textContent =
    state === STATE.SCANNING
      ? "SCANNING..."
      : state === STATE.RESULTS
      ? "RESCAN DOCUMENT"
      : "SCAN DOCUMENT";
}

function showNotice(message, kind) {
  els.notice.textContent = message;
  els.notice.classList.remove("hidden");
  if (kind === "info") els.notice.classList.add("info");
  else els.notice.classList.remove("info");
}

function clearNotice() {
  els.notice.textContent = "";
  els.notice.classList.add("hidden");
}

/* ------------------------------------------------------------------ *
 * Confirmation
 * ------------------------------------------------------------------ */

/**
 * Renders an in-panel confirmation and resolves true/false.
 * Deliberately not a UXP modal dialog: the panel is the plugin's only surface,
 * so every prompt and error stays in one place and cannot fail to open.
 */
function askConfirm(options) {
  stateBeforeConfirm = currentState;
  els.confirmTitle.textContent = options.title;
  els.confirmMessage.textContent = options.message || "";
  els.confirmOk.textContent = options.confirmLabel || "CONFIRM";

  const lines = options.lines || [];
  const shown = lines.slice(0, 60);

  removeChildren(els.confirmList);
  shown.forEach((line) => {
    els.confirmList.appendChild(makeEl("li", "layer-row", line));
  });
  if (lines.length > shown.length) {
    els.confirmList.appendChild(
      makeEl(
        "li",
        "layer-row",
        "…and " + (lines.length - shown.length) + " more"
      )
    );
  }

  setState(STATE.CONFIRM);

  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}

function settleConfirm(answer) {
  const resolve = confirmResolver;
  confirmResolver = null;
  if (resolve) resolve(answer);
}

/* ------------------------------------------------------------------ *
 * Results rendering
 * ------------------------------------------------------------------ */

function addRow(list, label, value, valueClass) {
  const row = makeEl("li", "stat-row");
  row.appendChild(makeEl("span", "stat-label", label));
  row.appendChild(makeEl("span", valueClass || "stat-value", value));
  list.appendChild(row);
}

function addStatRow(label, value) {
  addRow(els.statsList, label, value);
}

const TONE_CLASSES = [
  "tone-excellent",
  "tone-good",
  "tone-warn",
  "tone-critical",
];

function renderHealth(report, health) {
  els.healthValue.textContent = String(health.score);
  els.healthStatus.textContent = health.label;

  TONE_CLASSES.forEach((cls) => els.healthCard.classList.remove(cls));
  els.healthCard.classList.add("tone-" + health.tone);

  els.healthSub.textContent =
    report.totalIssues === 0
      ? "No cleanup issues detected."
      : report.totalIssues === 1
      ? "1 issue found"
      : report.totalIssues + " issues found";

  removeChildren(els.breakdownList);
  if (health.penalties.length) {
    health.penalties.forEach((penalty) => {
      addRow(
        els.breakdownList,
        penalty.title + "  (" + penalty.count + " × " + penalty.perItem + ")",
        "−" + penalty.points,
        "penalty-value"
      );
    });
    addRow(els.breakdownList, "Total penalty", "−" + health.totalPenalty);
  }
  setHidden(els.breakdownCard, health.penalties.length === 0);
}

/** Locked layers have no action attached, so they get no Fix Selected checkbox. */
function isSelectable(issue) {
  return issue.count > 0 && issue.id !== "lockedLayers";
}

function renderIssueCard(issue) {
  const card = makeEl("div", "issue-card");
  const hasItems = issue.count > 0;
  if (!hasItems) card.classList.add("is-empty");

  if (isSelectable(issue)) {
    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "issue-check";
    check.checked = selectedIssues.has(issue.id);
    // The whole card opens the detail view, so the checkbox must not bubble.
    check.addEventListener("click", (event) => event.stopPropagation());
    check.addEventListener("change", () => {
      if (check.checked) selectedIssues.add(issue.id);
      else selectedIssues.delete(issue.id);
      updateFixSelectedButton();
    });
    card.appendChild(check);
  }

  card.appendChild(makeIcon(issue.icon, "issue-icon"));

  const body = makeEl("div", "issue-body");
  body.appendChild(makeEl("div", "issue-title", issue.title));

  const countClass =
    "issue-count " + (hasItems ? (issue.informational ? "" : "warn") : "ok");
  const countText = hasItems
    ? issue.count + " " + issue.noun
    : "None " + (issue.informational ? "found" : "detected");
  body.appendChild(makeEl("div", countClass.trim(), countText));
  card.appendChild(body);

  if (hasItems) {
    card.appendChild(makeEl("div", "issue-chevron", "›"));
    card.addEventListener("click", () => showDetail(issue.id));
  }

  els.issueList.appendChild(card);
}

function updateFixSelectedButton() {
  const count = selectedIssues.size;
  els.fixSelected.disabled = count === 0;
  els.fixSelected.textContent =
    count === 0 ? "FIX SELECTED" : "FIX SELECTED (" + count + ")";
  els.fixHint.textContent =
    count === 0
      ? "Tick the issues you want LayerDoctor to handle."
      : "Only safe fixes run automatically. Anything else opens its review screen.";
}

function renderResults() {
  const snapshot = lastSnapshot;
  const report = lastReport;
  const stats = snapshot.stats;

  renderHealth(report, lastHealth);

  removeChildren(els.issueList);
  report.issues.forEach(renderIssueCard);
  updateFixSelectedButton();

  removeChildren(els.statsList);
  addStatRow("Document", snapshot.document.name);
  addStatRow("Total Layers", stats.totalLayers);
  addStatRow("Groups", stats.groups);
  addStatRow("Layers (non-group)", stats.normalLayers);
  addStatRow("Hidden", stats.hidden);
  addStatRow("Locked", stats.locked);
  addStatRow("Max Nesting Depth", stats.maxDepth);

  const treeLines = scanner.formatTree(snapshot.tree, "");
  els.treePreview.textContent = treeLines.length
    ? treeLines.join("\n")
    : "This document has no layers.";

  els.scanMeta.textContent =
    "Scanned " +
    stats.totalLayers +
    " layers in " +
    snapshot.durationMs +
    "ms  ·  " +
    (snapshot.method === "fast" ? "fast scan" : "DOM scan");

  setState(STATE.RESULTS);
}

/* ------------------------------------------------------------------ *
 * Detail (drill-down) rendering
 * ------------------------------------------------------------------ */

/**
 * One row per layer: name, then technical metadata, then (optionally) the reason
 * it was flagged on its own highlighted line. Keeping the reason separate stops
 * long explanations from being swallowed by the metadata run-on.
 */
function renderLayerRow(layer, reason) {
  const row = makeEl("li", "layer-row");
  row.appendChild(makeEl("div", "layer-row-name", layer.name || "(blank name)"));

  const meta = [layer.kind, "depth " + layer.depth];
  if (layer.parentName) meta.push("in " + layer.parentName);
  if (!layer.visible) meta.push("hidden");
  if (layer.locked) meta.push("locked");

  row.appendChild(makeEl("div", "layer-row-meta", meta.join("  ·  ")));
  if (reason) row.appendChild(makeEl("div", "layer-row-reason", reason));
  return row;
}

const DETAIL_NOTES = {
  badNames:
    "These names match LayerDoctor's default-name patterns. FIX ALL NAMES applies Type + Number naming after showing you the full plan.",
  duplicateNames:
    "Names are compared case-insensitively after trimming, so “Button” and “button” collide.",
  emptyLayers:
    "Only empty groups and zero-area raster layers with no mask are listed. Adjustment layers, smart objects, text and fills are never guessed about.",
  hiddenLayers:
    "Hidden layers are informational — LayerDoctor never deletes them automatically.",
  lockedLayers:
    "Locked layers are informational in V1. LayerDoctor does not unlock them.",
  deepNesting:
    "Groups nested deeper than the threshold. Restructuring is a manual job — LayerDoctor only points them out.",
};

function addDetailAction(label, handler, options) {
  const opts = options || {};
  const button = makeEl("button", "btn " + (opts.className || "btn-secondary"), label);
  button.disabled = opts.disabled === true;
  if (!button.disabled) button.addEventListener("click", handler);
  els.detailActions.appendChild(button);
}

function renderDetailActions(issue) {
  removeChildren(els.detailActions);

  if (issue.id === "badNames") {
    // One-click fix: deterministic Type + Number naming, still preview-gated by
    // the confirmation screen so nothing is renamed sight-unseen.
    addDetailAction("FIX ALL NAMES (" + issue.count + ")", runFixAllNames, {
      className: "btn-primary",
    });
    addDetailAction("MORE RENAME OPTIONS", () => openRenameTool(issue.id));
    return;
  }

  if (issue.id === "duplicateNames") {
    // No blanket fix here on purpose: "Button" / "button" are real names, and
    // renumbering them to "Pixel Layer 01" would destroy information.
    addDetailAction("RENAME THESE LAYERS", () => openRenameTool(issue.id), {
      className: "btn-primary",
    });
    return;
  }

  if (issue.id === "emptyLayers") {
    const deletable = issue.deletableCount || 0;
    addDetailAction(
      deletable
        ? "DELETE EMPTY LAYERS (" + deletable + ")"
        : "NOTHING SAFE TO DELETE",
      () => runDeleteEmptyLayers(),
      { className: "btn-danger", disabled: deletable === 0 }
    );
    return;
  }

  if (issue.id === "hiddenLayers") {
    addDetailAction(
      "SHOW ALL HIDDEN LAYERS (" + issue.count + ")",
      () => runShowAllHidden(),
      { className: "btn-primary" }
    );
  }
}

function showDetail(issueId) {
  const issue = getIssue(issueId);
  if (!issue) return;

  els.detailIcon.src = issue.icon;
  els.detailTitle.textContent = issue.title;

  let note = DETAIL_NOTES[issueId] || "";
  if (issueId === "deepNesting" && issue.threshold) {
    note += " Threshold: deeper than " + issue.threshold + " levels.";
  }
  if (issueId === "emptyLayers") {
    note +=
      " " + issue.deletableCount + " of " + issue.count + " are safe to delete.";
  }
  els.detailNote.textContent = note;

  renderDetailActions(issue);
  els.detailCount.textContent =
    issue.count +
    (issue.count === 1 ? " layer" : " layers") +
    (issue.count > 6 ? "  ·  scroll for more" : "");
  removeChildren(els.detailList);

  if (issueId === "duplicateNames" && issue.sets) {
    issue.sets.forEach((set) => {
      els.detailList.appendChild(
        makeEl(
          "div",
          "layer-group-header",
          '"' + set.displayName + '"  —  ' + set.count + " layers"
        )
      );
      set.layers.forEach((layer) => {
        els.detailList.appendChild(renderLayerRow(layer));
      });
    });
  } else if (issueId === "badNames" && issue.findings) {
    issue.findings.forEach((finding) => {
      els.detailList.appendChild(renderLayerRow(finding.layer, finding.reason));
    });
  } else if (issueId === "emptyLayers" && issue.findings) {
    issue.findings.forEach((finding) => {
      const note =
        finding.reason +
        (finding.safeToDelete
          ? " · safe to delete"
          : " · kept (" + finding.blockedBy + ")");
      els.detailList.appendChild(renderLayerRow(finding.layer, note));
    });
  } else {
    issue.layers.forEach((layer) => {
      els.detailList.appendChild(renderLayerRow(layer));
    });
  }

  setState(STATE.DETAIL);
}

/* ------------------------------------------------------------------ *
 * Rename tool
 * ------------------------------------------------------------------ */

const RENAME_SCOPES = [
  { id: "badNames", label: "BAD NAMES" },
  { id: "duplicateNames", label: "DUPLICATES" },
  { id: "selection", label: "SELECTED" },
];

const RENAME_STRATEGIES = [
  { id: "type", label: "TYPE + #" },
  { id: "prefix", label: "PREFIX" },
  { id: "findReplace", label: "FIND/REPLACE" },
];

/** Snapshot layers for a scope. "selection" reads Photoshop's current selection. */
function getScopeTargets(scopeId) {
  if (!lastSnapshot) return [];

  if (scopeId === "selection") {
    const ids = new Set(fixers.getSelectedLayerIds());
    return lastSnapshot.layers.filter((layer) => ids.has(layer.id));
  }

  const issue = getIssue(scopeId);
  return issue ? issue.layers.slice() : [];
}

function renderSegmented(container, items, activeId, onPick, countFor) {
  removeChildren(container);
  items.forEach((item) => {
    const count = countFor ? countFor(item.id) : null;
    const label = count === null ? item.label : item.label + " (" + count + ")";
    const button = makeEl("button", "seg-btn", label);
    if (item.id === activeId) button.classList.add("is-active");
    if (count === 0) button.disabled = true;
    else button.addEventListener("click", () => onPick(item.id));
    container.appendChild(button);
  });
}

function renderRenameControls() {
  renderSegmented(
    els.renameScope,
    RENAME_SCOPES,
    renameState.scope,
    (id) => {
      renameState.scope = id;
      renderRenameControls();
      updateRenamePreview();
    },
    (id) => getScopeTargets(id).length
  );

  renderSegmented(
    els.renameStrategy,
    RENAME_STRATEGIES,
    renameState.strategy,
    (id) => {
      renameState.strategy = id;
      renderRenameControls();
      updateRenamePreview();
    },
    null
  );

  setHidden(els.fieldPrefix, renameState.strategy !== "prefix");
  setHidden(els.fieldFind, renameState.strategy !== "findReplace");

  const targets = getScopeTargets(renameState.scope);
  els.renameScopeHint.textContent =
    renameState.scope === "selection"
      ? targets.length +
        " layer(s) selected in Photoshop. Change the selection and reopen to refresh."
      : targets.length + " layer(s) in this category.";
}

/** Recomputes the preview from the current controls. Pure planning, no writes. */
function updateRenamePreview() {
  const targets = getScopeTargets(renameState.scope);
  const plan = fixers.buildRenamePlan(
    renameState.strategy,
    targets,
    lastSnapshot ? lastSnapshot.layers : [],
    {
      prefix: els.inputPrefix.value,
      find: els.inputFind.value,
      replace: els.inputReplace.value,
    }
  );

  renameState.plan = plan;
  removeChildren(els.renamePreview);

  plan.slice(0, 200).forEach((item) => {
    const row = makeEl("li", "preview-row");
    row.appendChild(makeEl("div", "preview-from", item.from));
    row.appendChild(makeEl("div", "preview-to", "→  " + item.to));
    els.renamePreview.appendChild(row);
  });

  if (!plan.length) {
    els.renamePreviewCount.textContent =
      renameState.strategy === "prefix" && !els.inputPrefix.value.trim()
        ? "Enter a prefix to preview the new names."
        : renameState.strategy === "findReplace" && !els.inputFind.value
        ? "Enter text to find."
        : "No changes to apply.";
  } else {
    els.renamePreviewCount.textContent =
      plan.length +
      " layer(s) will be renamed" +
      (plan.length > 200 ? " (showing the first 200)" : "") +
      ".";
  }

  els.renameApply.disabled = plan.length === 0;
}

function openRenameTool(scopeId) {
  if (!lastReport) return;

  const requested = scopeId || renameState.scope;
  const hasTargets = getScopeTargets(requested).length > 0;
  renameState.scope = hasTargets
    ? requested
    : (RENAME_SCOPES.find((s) => getScopeTargets(s.id).length > 0) || RENAME_SCOPES[0]).id;

  clearNotice();
  renderRenameControls();
  updateRenamePreview();
  setState(STATE.RENAME);
}

/* ------------------------------------------------------------------ *
 * Mutations
 * ------------------------------------------------------------------ */

/** Formats a mutation result into a single panel notice. */
function describeResult(verb, result) {
  const parts = [];
  if (result.applied) parts.push(verb + " " + result.applied + " layer(s).");
  if (result.failures.length) {
    const sample = result.failures
      .slice(0, 3)
      .map((f) => f.name + " (" + f.reason + ")")
      .join("; ");
    parts.push(
      result.failures.length +
        " could not be changed: " +
        sample +
        (result.failures.length > 3 ? "…" : "")
    );
  }
  if (!parts.length) parts.push("Nothing to change.");
  return parts.join(" ");
}

/**
 * Runs a document mutation, then rescans so the report always matches the
 * document. The notice is shown after the rescan, which clears notices itself.
 */
async function runMutation(busyLabel, verb, work) {
  els.busyTitle.textContent = busyLabel;
  clearNotice();
  setState(STATE.BUSY);
  await tick();

  let result;
  try {
    result = await work();
  } catch (err) {
    console.error("[LayerDoctor] " + busyLabel + " failed:", err);
    setState(lastReport ? STATE.RESULTS : STATE.READY);
    showNotice(
      (err && err.message) || "Photoshop rejected the operation.",
      "error"
    );
    return null;
  }

  console.log("[LayerDoctor] " + busyLabel + " result:", result);
  selectedIssues.clear();
  await handleScan();
  showNotice(describeResult(verb, result), result.failures.length ? "error" : "info");
  return result;
}

async function runApplyRenames() {
  const plan = renameState.plan.slice();
  if (!plan.length) return;
  await runMutation("Renaming layers...", "Renamed", () =>
    fixers.applyRenames(plan)
  );
}

/**
 * One-click fix for the Bad Layer Names screen: applies Type + Number naming to
 * every flagged layer. The confirmation lists the complete old → new plan, so
 * this is still preview-gated — it just skips the strategy picker.
 */
async function runFixAllNames() {
  const issue = getIssue("badNames");
  if (!issue || !issue.count || !lastSnapshot) return;

  const plan = fixers.buildRenamePlan(
    "type",
    issue.layers,
    lastSnapshot.layers,
    {}
  );

  if (!plan.length) {
    showNotice("These names already match the Type + Number pattern.", "info");
    return;
  }

  const confirmed = await askConfirm({
    title: "Rename " + plan.length + " layer(s)?",
    message:
      "Type + Number naming is applied to every badly named layer. Existing names are not reused, and one Photoshop Undo reverts the whole batch.",
    confirmLabel: "RENAME ALL",
    lines: plan.map((item) => item.from + "   →   " + item.to),
  });

  if (!confirmed) {
    setState(stateBeforeConfirm);
    return;
  }

  await runMutation("Renaming layers...", "Renamed", () =>
    fixers.applyRenames(plan)
  );
}

/** Returns the mutation result, or null when cancelled / nothing to do / failed. */
async function runDeleteEmptyLayers() {
  const issue = getIssue("emptyLayers");
  if (!issue || !issue.findings) return null;

  const deletable = issue.findings.filter((finding) => finding.safeToDelete);
  if (!deletable.length) {
    showNotice(
      "None of the empty layers can be deleted safely — they are locked or unverified.",
      "info"
    );
    return null;
  }

  const confirmed = await askConfirm({
    title: "Delete " + deletable.length + " empty layer(s)?",
    message:
      "This removes the layers listed below. It can be undone with Photoshop's Undo (one step). Layers that are locked or whose mask state could not be verified are not included.",
    confirmLabel: "DELETE",
    lines: deletable.map((finding) => finding.layer.name + "  ·  " + finding.reason),
  });

  if (!confirmed) {
    setState(stateBeforeConfirm);
    return null;
  }

  return runMutation("Deleting empty layers...", "Deleted", () =>
    fixers.deleteLayers(deletable.map((finding) => finding.layer.id))
  );
}

async function runShowAllHidden() {
  const issue = getIssue("hiddenLayers");
  if (!issue || !issue.count) return;

  await runMutation("Showing hidden layers...", "Revealed", () =>
    fixers.showLayers(issue.layers.map((layer) => layer.id))
  );
}

/* ------------------------------------------------------------------ *
 * Fix Selected
 * ------------------------------------------------------------------ */

/**
 * Only empty-layer deletion runs automatically, and only for layers already
 * proven safe. Renaming is never automatic — it always goes through the preview.
 * Everything else opens its review screen.
 */
async function handleFixSelected() {
  if (!lastReport || !selectedIssues.size) return;

  const chosen = Array.from(selectedIssues);
  const reviewOnly = chosen.filter((id) => id !== "emptyLayers");

  let deleteResult = null;
  if (selectedIssues.has("emptyLayers")) {
    deleteResult = await runDeleteEmptyLayers();
    // A cancelled or failed deletion should not silently jump elsewhere.
    if (!deleteResult) return;
  }

  if (!reviewOnly.length) return;

  const first = reviewOnly[0];
  const titles = reviewOnly
    .map((id) => {
      const issue = getIssue(id);
      return issue ? issue.title : id;
    })
    .join(", ");

  if (first === "badNames" || first === "duplicateNames") {
    openRenameTool(first);
  } else {
    showDetail(first);
  }

  // runMutation already rescanned and posted its own notice; keep both messages.
  const review = titles + " cannot be fixed automatically — review required.";
  showNotice(
    deleteResult ? describeResult("Deleted", deleteResult) + " " + review : review,
    "info"
  );
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

/** One checkbox row. Returns the input so the caller can read it back on save. */
function addToggleRow(container, label, checked) {
  const row = makeEl("div", "toggle-row");

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked === true;

  const text = makeEl("div", "toggle-label", label);
  if (!input.checked) text.classList.add("is-off");
  input.addEventListener("change", () => {
    if (input.checked) text.classList.remove("is-off");
    else text.classList.add("is-off");
  });

  row.appendChild(input);
  row.appendChild(text);
  container.appendChild(row);
  return input;
}

/** Rule id → checkbox, rebuilt every time the screen opens. */
const ruleInputs = {};
const perfInputs = {};

function renderSettings() {
  els.inputThreshold.value = String(settings.deepNestingThreshold);

  removeChildren(els.settingsRules);
  Object.keys(ruleInputs).forEach((key) => delete ruleInputs[key]);
  analyzers.BAD_NAME_RULES.forEach((rule) => {
    ruleInputs[rule.id] = addToggleRow(
      els.settingsRules,
      rule.settingLabel || rule.label,
      settings.badNameRules[rule.id] === true
    );
  });

  removeChildren(els.settingsPerformance);
  perfInputs.fastScan = addToggleRow(
    els.settingsPerformance,
    "Fast scan (one batchPlay call)",
    settings.fastScan
  );
  perfInputs.includeLockDetail = addToggleRow(
    els.settingsPerformance,
    "Detailed lock flags (slower on the DOM path)",
    settings.includeLockDetail
  );
}

function collectSettings() {
  const badNameRules = {};
  Object.keys(ruleInputs).forEach((ruleId) => {
    badNameRules[ruleId] = ruleInputs[ruleId].checked;
  });

  return {
    deepNestingThreshold: els.inputThreshold.value,
    badNameRules,
    fastScan: perfInputs.fastScan.checked,
    includeLockDetail: perfInputs.includeLockDetail.checked,
  };
}

function openSettings() {
  clearNotice();
  renderSettings();
  setState(STATE.SETTINGS);
}

async function handleSettingsSave() {
  settings = settingsStore.save(collectSettings());
  console.log("[LayerDoctor] Settings saved:", settings);

  if (scanner.getActiveDocument()) {
    await handleScan();
    showNotice("Settings saved. Document rescanned.", "info");
  } else {
    refreshDocumentState();
    showNotice("Settings saved.", "info");
  }
}

function handleSettingsReset() {
  settings = settingsStore.reset();
  renderSettings();
  showNotice("Settings restored to defaults. Save to apply.", "info");
}

/* ------------------------------------------------------------------ *
 * Document state
 * ------------------------------------------------------------------ */

function readDocId(doc) {
  try {
    return doc.id;
  } catch (err) {
    return null;
  }
}

function refreshDocumentState() {
  const doc = scanner.getActiveDocument();

  if (!doc) {
    lastSnapshot = null;
    lastReport = null;
    lastHealth = null;
    selectedIssues.clear();
    clearNotice();
    setState(STATE.NO_DOC);
    return;
  }

  const docId = readDocId(doc);

  // Same document as the last scan — keep showing its results.
  if (lastSnapshot && docId !== null && lastSnapshot.document.id === docId) {
    setState(STATE.RESULTS);
    return;
  }

  lastSnapshot = null;
  lastReport = null;
  lastHealth = null;
  selectedIssues.clear();
  clearNotice();
  try {
    els.readyDocName.textContent = doc.name;
  } catch (err) {
    els.readyDocName.textContent = "";
  }
  setState(STATE.READY);
}

/* ------------------------------------------------------------------ *
 * Scanning
 * ------------------------------------------------------------------ */

async function handleScan() {
  if (isScanning) return;
  isScanning = true;
  clearNotice();
  setState(STATE.SCANNING);
  await tick();

  try {
    const snapshot = await scanner.scanDocument({
      fastScan: settings.fastScan,
      includeLockDetail: settings.includeLockDetail,
    });

    // Layer masks are not exposed by the UXP DOM. The fast path already returns
    // them; otherwise ask Photoshop about the handful of candidate empty layers
    // in one batchPlay round trip.
    const candidates = analyzers.findEmptyLayerCandidates(snapshot.layers);
    await scanner.enrichMaskInfo(
      snapshot,
      candidates.map((layer) => layer.id)
    );

    const report = analyzers.analyzeSnapshot(snapshot, settings);
    const health = scoring.calculateScore(report);

    lastSnapshot = snapshot;
    lastReport = report;
    lastHealth = health;

    scanner.logSnapshot(snapshot);
    analyzers.logReport(report);
    scoring.logScore(health);
    renderResults();
  } catch (err) {
    console.error("[LayerDoctor] Scan failed:", err);
    handleScanError(err);
  } finally {
    isScanning = false;
  }
}

function handleScanError(err) {
  if (err && err.code === "NO_DOCUMENT") {
    setState(STATE.NO_DOC);
    showNotice("Open a Photoshop document before running LayerDoctor.", "info");
    return;
  }

  setState(scanner.getActiveDocument() ? STATE.READY : STATE.NO_DOC);
  showNotice(
    "Scan failed: " + ((err && err.message) || "Unknown Photoshop error."),
    "error"
  );
}

function handleBack() {
  if (lastReport) setState(STATE.RESULTS);
  else refreshDocumentState();
}

/**
 * Header reload: rescans from wherever the user is. Ignored mid-mutation and
 * mid-confirmation so it cannot interrupt a Photoshop modal or discard a prompt
 * the user is still answering.
 */
async function handleReload() {
  if (isScanning || currentState === STATE.BUSY || currentState === STATE.CONFIRM) {
    return;
  }

  if (scanner.getActiveDocument()) {
    await handleScan();
  } else {
    refreshDocumentState();
  }
}

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

/**
 * Photoshop's "select" event fires for layer selection too, not just documents,
 * so ignore notifications that leave the active document unchanged. Without this
 * guard, clicking a layer in Photoshop would bounce the user out of a detail view.
 */
function handleDocumentNotification() {
  if (isScanning || currentState === STATE.BUSY || currentState === STATE.CONFIRM) {
    return;
  }

  const doc = scanner.getActiveDocument();
  const docId = doc ? readDocId(doc) : null;
  const scannedId = lastSnapshot ? lastSnapshot.document.id : null;

  if (doc && lastSnapshot && docId !== null && docId === scannedId) return;

  refreshDocumentState();
}

async function registerDocumentListeners() {
  try {
    await action.addNotificationListener(
      [
        { event: "open" },
        { event: "close" },
        { event: "select" },
        { event: "newDocument" },
      ],
      handleDocumentNotification
    );
  } catch (err) {
    console.warn("[LayerDoctor] Document listeners unavailable:", err);
  }
}

/**
 * Last-resort net for anything that escapes a try/catch. The panel should always
 * show what went wrong rather than freezing in whatever state it was in.
 */
function registerGlobalErrorHandlers() {
  const report = (label, detail) => {
    console.error("[LayerDoctor] " + label + ":", detail);
    try {
      if (currentState === STATE.BUSY || currentState === STATE.SCANNING) {
        setState(lastReport ? STATE.RESULTS : STATE.READY);
      }
      showNotice(
        label + ": " + (detail && detail.message ? detail.message : detail),
        "error"
      );
    } catch (err) {
      /* the panel may not be built yet — the console line above still stands */
    }
  };

  try {
    window.addEventListener("error", (event) => {
      report("Unexpected error", event.error || event.message);
    });
    window.addEventListener("unhandledrejection", (event) => {
      report("Unhandled error", event.reason);
      if (typeof event.preventDefault === "function") event.preventDefault();
    });
  } catch (err) {
    console.warn("[LayerDoctor] Global error handlers unavailable:", err);
  }
}

function init() {
  cacheElements();
  registerGlobalErrorHandlers();

  settings = settingsStore.load();
  console.log("[LayerDoctor] Settings loaded:", settings);

  els.scanButton.addEventListener("click", handleScan);
  els.backButton.addEventListener("click", handleBack);
  els.fixSelected.addEventListener("click", handleFixSelected);

  els.renameBack.addEventListener("click", handleBack);
  els.renameCancel.addEventListener("click", handleBack);
  els.renameApply.addEventListener("click", runApplyRenames);
  els.inputPrefix.addEventListener("input", updateRenamePreview);
  els.inputFind.addEventListener("input", updateRenamePreview);
  els.inputReplace.addEventListener("input", updateRenamePreview);

  els.confirmOk.addEventListener("click", () => settleConfirm(true));
  els.confirmCancel.addEventListener("click", () => settleConfirm(false));

  els.reloadButton.addEventListener("click", handleReload);
  els.settingsButton.addEventListener("click", openSettings);
  els.settingsBack.addEventListener("click", handleBack);
  els.settingsSave.addEventListener("click", handleSettingsSave);
  els.settingsReset.addEventListener("click", handleSettingsReset);

  refreshDocumentState();
  registerDocumentListeners();
  console.log("[LayerDoctor] Panel ready.");
}

init();
