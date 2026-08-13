/*
 * fixers.js — the only module that MODIFIES the document.
 *
 * Two clearly separated halves:
 *   1. Rename planning — pure functions. Given snapshot layers they produce a
 *      { id, from, to } plan. Nothing touches Photoshop, so the preview the user
 *      approves is exactly what gets applied.
 *   2. Mutations — every one runs inside core.executeAsModal() and wraps its work
 *      in suspendHistory/resumeHistory so the whole batch collapses into a single
 *      Photoshop Undo step.
 *
 * Safety rules baked in here:
 *   - Layers are re-resolved by id at apply time. A layer that vanished since the
 *     scan is reported as a failure, never silently skipped.
 *   - Only layers explicitly passed in are touched. Nothing is inferred.
 *   - A failure on one layer never aborts the rest of the batch.
 */

const { app, core } = require("photoshop");

/* ------------------------------------------------------------------ *
 * Rename planning (pure)
 * ------------------------------------------------------------------ */

/** Layer kind → human label used by the Type + Number strategy. */
const TYPE_LABELS = {
  pixel: "Pixel Layer",
  normal: "Pixel Layer",
  group: "Group",
  text: "Text",
  smartobject: "Smart Object",
  solidcolor: "Shape",
  gradient: "Shape",
  pattern: "Shape",
  // The fast scan path reports the ActionManager kinds "shape" and "adjustment".
  shape: "Shape",
  video: "Video",
  layer3d: "3D",
};

const ADJUSTMENT_KINDS = [
  "adjustment",
  "levels",
  "curves",
  "exposure",
  "vibrance",
  "huesaturation",
  "colorbalance",
  "blackandwhite",
  "photofilter",
  "channelmixer",
  "colorlookup",
  "invert",
  "posterize",
  "threshold",
  "selectivecolor",
  "gradientmap",
  "brightnesscontrast",
];

function typeLabelFor(layer) {
  const kind = String(layer.kind || "").toLowerCase();
  if (TYPE_LABELS[kind]) return TYPE_LABELS[kind];
  if (ADJUSTMENT_KINDS.indexOf(kind) !== -1) return "Adjustment";
  return "Layer";
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

function normalize(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Names already taken by layers that are NOT part of this rename, so the planner
 * can avoid creating fresh duplicates.
 */
function buildUsedNameSet(allLayers, targetIds) {
  const skip = new Set(targetIds);
  const used = new Set();
  allLayers.forEach((layer) => {
    if (!skip.has(layer.id)) used.add(normalize(layer.name));
  });
  return used;
}

/** Appends " 2", " 3", … until the name is free. Mutates `used`. */
function makeUniqueName(base, used) {
  const trimmed = String(base).trim() || "Layer";
  if (!used.has(normalize(trimmed))) {
    used.add(normalize(trimmed));
    return trimmed;
  }
  let suffix = 2;
  while (used.has(normalize(trimmed + " " + suffix))) suffix += 1;
  const unique = trimmed + " " + suffix;
  used.add(normalize(unique));
  return unique;
}

/** Sequential "<label> 01" per layer type, skipping names already in use. */
function planTypeNumberRename(targets, used) {
  const counters = {};
  const plan = [];

  targets.forEach((layer) => {
    const label = typeLabelFor(layer);
    let counter = counters[label] || 0;
    let candidate;
    do {
      counter += 1;
      candidate = label + " " + pad2(counter);
    } while (used.has(normalize(candidate)));

    counters[label] = counter;
    used.add(normalize(candidate));
    plan.push({ id: layer.id, from: layer.name, to: candidate });
  });

  return plan.filter((item) => item.from !== item.to);
}

/** Sequential "<prefix> 01" across the whole selection. */
function planPrefixRename(targets, prefix, used) {
  const base = String(prefix || "").trim();
  if (!base) return [];

  let counter = 0;
  const plan = [];

  targets.forEach((layer) => {
    let candidate;
    do {
      counter += 1;
      candidate = base + " " + pad2(counter);
    } while (used.has(normalize(candidate)));

    used.add(normalize(candidate));
    plan.push({ id: layer.id, from: layer.name, to: candidate });
  });

  return plan.filter((item) => item.from !== item.to);
}

/**
 * Case-insensitive literal find/replace across every occurrence in the name.
 * Layers whose name does not change are dropped from the plan.
 */
function planFindReplaceRename(targets, find, replace, used) {
  const needle = String(find || "");
  if (!needle) return [];

  const pattern = new RegExp(escapeRegExp(needle), "gi");
  const plan = [];

  targets.forEach((layer) => {
    const replaced = String(layer.name).replace(pattern, String(replace || ""));
    const cleaned = replaced.replace(/\s+/g, " ").trim();
    if (!cleaned || cleaned === layer.name) return;

    plan.push({ id: layer.id, from: layer.name, to: makeUniqueName(cleaned, used) });
  });

  return plan;
}

/**
 * Removes Photoshop's duplication suffixes, keeping the meaningful part of the
 * name: "Hero copy 4" → "Hero", "Logo copy copy" → "Logo".
 * Collisions are numbered, so three copies of "Hero" become Hero, Hero 2, Hero 3
 * instead of collapsing into an ambiguous pile.
 */
function planStripCopyRename(targets, used) {
  const plan = [];

  targets.forEach((layer) => {
    let cleaned = String(layer.name);
    let previous;
    do {
      previous = cleaned;
      cleaned = cleaned.replace(/\s*\bcopy\b(\s*\d+)?\s*$/i, "").trim();
    } while (cleaned !== previous && cleaned.length);

    cleaned = cleaned.replace(/\s+/g, " ").trim();
    if (!cleaned || cleaned === layer.name) return;

    plan.push({ id: layer.id, from: layer.name, to: makeUniqueName(cleaned, used) });
  });

  return plan;
}

/** Trims a text layer's contents down to something usable as a layer name. */
function nameFromText(text) {
  return String(text || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 30)
    .trim();
}

/**
 * Renames text layers to their own contents — what people usually mean by
 * "smart naming", achieved deterministically with no AI involved.
 * Layers without readable text are left alone.
 */
function planFromTextRename(targets, used) {
  const plan = [];

  targets.forEach((layer) => {
    const candidate = nameFromText(layer.textContent);
    if (!candidate || candidate === layer.name) return;

    plan.push({ id: layer.id, from: layer.name, to: makeUniqueName(candidate, used) });
  });

  return plan;
}

/** Strategy dispatcher. `options` carries prefix / find / replace. */
function buildRenamePlan(strategy, targets, allLayers, options) {
  const opts = options || {};
  const used = buildUsedNameSet(allLayers, targets.map((l) => l.id));

  if (strategy === "prefix") return planPrefixRename(targets, opts.prefix, used);
  if (strategy === "findReplace") {
    return planFindReplaceRename(targets, opts.find, opts.replace, used);
  }
  if (strategy === "stripCopy") return planStripCopyRename(targets, used);
  if (strategy === "fromText") return planFromTextRename(targets, used);
  return planTypeNumberRename(targets, used);
}

/* ------------------------------------------------------------------ *
 * Photoshop mutations (modal)
 * ------------------------------------------------------------------ */

function requireActiveDocument() {
  let doc = null;
  try {
    if (app.documents && app.documents.length > 0) doc = app.activeDocument;
  } catch (err) {
    doc = null;
  }
  if (!doc) {
    const error = new Error(
      "The document is no longer open. Reopen it and scan again."
    );
    error.code = "NO_DOCUMENT";
    throw error;
  }
  return doc;
}

/**
 * Runs `work` as a single modal, single-undo operation.
 * suspendHistory groups every change into one history entry named `commandName`,
 * so Photoshop's Ctrl/Cmd+Z reverts the whole batch rather than layer by layer.
 */
async function runAsSingleUndo(commandName, documentId, work) {
  try {
    return await core.executeAsModal(
      async (context) => {
        let suspensionId = null;
        try {
          suspensionId = await context.hostControl.suspendHistory({
            documentID: documentId,
            name: commandName,
          });
        } catch (err) {
          // Losing history grouping is not fatal — the edits still apply, they
          // just undo individually.
          console.warn("[LayerDoctor] suspendHistory unavailable:", err);
        }

        try {
          return await work(context);
        } finally {
          if (suspensionId !== null) {
            try {
              await context.hostControl.resumeHistory(suspensionId);
            } catch (err) {
              console.warn("[LayerDoctor] resumeHistory failed:", err);
            }
          }
        }
      },
      { commandName }
    );
  } catch (err) {
    // Photoshop refuses a modal while another one is running, or while a dialog
    // is open. Surface that as something the user can act on.
    const message = String((err && err.message) || err);
    if (/modal|busy|another/i.test(message)) {
      const wrapped = new Error(
        "Photoshop is busy with another operation. Close any open dialog and try again."
      );
      wrapped.code = "MODAL_BUSY";
      throw wrapped;
    }
    throw err;
  }
}

/** Recursively maps layer id → live Photoshop Layer for the current document. */
function buildLiveLayerMap(doc) {
  const map = new Map();

  const walk = (layers) => {
    if (!layers) return;
    for (const layer of layers) {
      let id = null;
      try {
        id = layer.id;
      } catch (err) {
        id = null;
      }
      if (id !== null) map.set(id, layer);

      let children = null;
      try {
        children = layer.layers;
      } catch (err) {
        children = null;
      }
      if (Array.isArray(children) && children.length) walk(children);
    }
  };

  try {
    walk(doc.layers);
  } catch (err) {
    console.warn("[LayerDoctor] Could not read the layer tree:", err);
  }

  return map;
}

/** Shared result shape for every mutation. */
function emptyResult() {
  return { applied: 0, failures: [] };
}

/**
 * Applies a rename plan. Each entry is re-resolved by id, so layers deleted since
 * the scan are reported rather than skipped silently.
 */
async function applyRenames(plan) {
  const result = emptyResult();
  if (!plan || !plan.length) return result;

  const doc = requireActiveDocument();

  return runAsSingleUndo("LayerDoctor: Rename Layers", doc.id, async () => {
    const live = buildLiveLayerMap(doc);

    for (const item of plan) {
      const layer = live.get(item.id);
      if (!layer) {
        result.failures.push({
          name: item.from,
          reason: "Layer no longer exists",
        });
        continue;
      }

      try {
        layer.name = item.to;
        result.applied += 1;
      } catch (err) {
        result.failures.push({
          name: item.from,
          reason: (err && err.message) || "Rename was rejected by Photoshop",
        });
      }
    }

    return result;
  });
}

/**
 * Deletes the given layer ids. Callers must pass only ids they have already
 * proven safe (see analyzers.findEmptyLayers → safeToDelete).
 */
async function deleteLayers(ids) {
  const result = emptyResult();
  if (!ids || !ids.length) return result;

  const doc = requireActiveDocument();

  return runAsSingleUndo("LayerDoctor: Delete Empty Layers", doc.id, async () => {
    const live = buildLiveLayerMap(doc);

    for (const id of ids) {
      const layer = live.get(id);
      if (!layer) {
        result.failures.push({ name: "Layer " + id, reason: "Layer no longer exists" });
        continue;
      }

      let name = "Layer " + id;
      try {
        name = layer.name;
      } catch (err) {
        /* keep the fallback name */
      }

      try {
        layer.delete();
        result.applied += 1;
      } catch (err) {
        result.failures.push({
          name,
          reason: (err && err.message) || "Photoshop refused to delete this layer",
        });
      }
    }

    return result;
  });
}

/** Turns the given layers visible again. Non-destructive and undoable. */
async function showLayers(ids) {
  const result = emptyResult();
  if (!ids || !ids.length) return result;

  const doc = requireActiveDocument();

  return runAsSingleUndo("LayerDoctor: Show Hidden Layers", doc.id, async () => {
    const live = buildLiveLayerMap(doc);

    for (const id of ids) {
      const layer = live.get(id);
      if (!layer) {
        result.failures.push({ name: "Layer " + id, reason: "Layer no longer exists" });
        continue;
      }

      try {
        layer.visible = true;
        result.applied += 1;
      } catch (err) {
        result.failures.push({
          name: "Layer " + id,
          reason: (err && err.message) || "Could not change visibility",
        });
      }
    }

    return result;
  });
}

/**
 * Selects the given layers in Photoshop's Layers panel.
 *
 * There is no DOM call that replaces the whole selection, so this uses batchPlay:
 * the first layer replaces the selection and the rest are added to it. Selecting
 * is not a document edit, so it is NOT wrapped in suspendHistory — it should not
 * create an undo step. `makeVisible: false` means selecting a hidden layer does
 * not silently un-hide it.
 */
async function selectLayers(ids) {
  const result = emptyResult();
  const targets = (ids || []).filter((id) => typeof id === "number");
  if (!targets.length) return result;

  requireActiveDocument();

  const commands = targets.map((id, index) => {
    const command = {
      _obj: "select",
      _target: [{ _ref: "layer", _id: id }],
      makeVisible: false,
      _options: { dialogOptions: "dontDisplay" },
    };
    if (index > 0) {
      command.selectionModifier = {
        _enum: "selectionModifierType",
        _value: "addToSelection",
      };
    }
    return command;
  });

  try {
    await core.executeAsModal(
      async () => {
        await require("photoshop").action.batchPlay(commands, {
          synchronousExecution: false,
        });
      },
      { commandName: "LayerDoctor: Select Layers" }
    );
    result.applied = targets.length;
  } catch (err) {
    console.warn("[LayerDoctor] Could not select layers:", err);
    result.failures.push({
      name: targets.length + " layer(s)",
      reason:
        (err && err.message) ||
        "Photoshop would not change the selection right now",
    });
  }

  return result;
}

/** Ids of the layers currently selected in Photoshop's Layers panel. */
function getSelectedLayerIds() {
  try {
    const doc = requireActiveDocument();
    const selected = doc.activeLayers || [];
    return selected
      .map((layer) => {
        try {
          return layer.id;
        } catch (err) {
          return null;
        }
      })
      .filter((id) => id !== null);
  } catch (err) {
    return [];
  }
}

module.exports = {
  TYPE_LABELS,
  typeLabelFor,
  buildUsedNameSet,
  planTypeNumberRename,
  planPrefixRename,
  planFindReplaceRename,
  planStripCopyRename,
  planFromTextRename,
  nameFromText,
  buildRenamePlan,
  applyRenames,
  deleteLayers,
  showLayers,
  selectLayers,
  getSelectedLayerIds,
};
