/*
 * scanner.js — reads the active Photoshop document into a lightweight,
 * plain-JavaScript representation.
 *
 * Design rules:
 *   - The document is read ONCE. Every later phase (analyzers, scoring, fixers)
 *     works on the snapshot returned by scanDocument(), never on the live DOM.
 *   - Everything here uses the Photoshop UXP DOM API. No batchPlay is needed
 *     for reading the layer tree.
 *   - Property access on a Photoshop Layer is a real IPC call into Photoshop and
 *     can throw for exotic layer types, so every read is guarded.
 */

const { app, action } = require("photoshop");
const { batchPlay } = action;

/**
 * Per-property scan toggles. Each extra property is one more IPC call per layer,
 * so these exist to trade detail for speed on very large documents.
 */
const SCAN_OPTIONS = {
  includeBounds: true,
  includeLockDetail: true,
};

/* ------------------------------------------------------------------ *
 * Low-level guarded readers
 * ------------------------------------------------------------------ */

/** Reads a Photoshop property, returning `fallback` if it throws or is undefined. */
function safeRead(read, fallback) {
  try {
    const value = read();
    return value === undefined || value === null ? fallback : value;
  } catch (err) {
    return fallback;
  }
}

/** Photoshop sometimes returns unit objects ({ _value, _unit }) instead of numbers. */
function toNumber(value) {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && typeof value._value === "number") {
    return value._value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * `layer.kind` is a string constant in modern Photoshop ("pixel", "group", ...)
 * but older builds returned a numeric LayerKind enum. Normalize to a string.
 */
function normalizeKind(rawKind) {
  if (typeof rawKind === "string") return rawKind;
  if (typeof rawKind === "number") {
    const legacy = {
      1: "normal",
      2: "text",
      3: "solidColor",
      4: "gradient",
      5: "pattern",
      6: "smartObject",
      7: "group",
      8: "video",
      9: "layer3D",
    };
    return legacy[rawKind] || "unknown";
  }
  return "unknown";
}

/** True when the layer is a group (a layer set that can contain children). */
function isGroupLayer(layer, kind) {
  if (typeof kind === "string" && kind.toLowerCase() === "group") return true;
  // Fallback for builds where `kind` is unavailable: only groups expose children.
  const children = safeRead(() => layer.layers, undefined);
  return Array.isArray(children) && children.length > 0;
}

/* ------------------------------------------------------------------ *
 * Snapshot building
 * ------------------------------------------------------------------ */

/**
 * Converts one Photoshop Layer into a plain object.
 * Never holds a reference to the live layer — only its id, so a later fix pass
 * can re-resolve it and notice if the layer disappeared in the meantime.
 */
function describeLayer(layer, depth, parent) {
  const kind = normalizeKind(safeRead(() => layer.kind, undefined));
  const isGroup = isGroupLayer(layer, kind);

  const info = {
    id: safeRead(() => layer.id, null),
    name: String(safeRead(() => layer.name, "")),
    kind,
    isGroup,
    visible: safeRead(() => layer.visible, true) === true,
    locked: false,
    lockDetail: null,
    opacity: toNumber(safeRead(() => layer.opacity, null)),
    depth,
    parentId: parent ? parent.id : null,
    parentName: parent ? parent.name : null,
    path: "",
    childCount: 0,
    hasChildren: false,
    bounds: null,
    width: null,
    height: null,
    children: [],
  };

  // Breadcrumb built from the parent snapshot — costs no extra Photoshop calls.
  info.path = parent ? parent.path + " / " + info.name : info.name;

  // Text contents power the "name from text" rename strategy. Only read for
  // text layers so the extra IPC call is not paid on every layer.
  info.textContent = null;
  if (kind === "text") {
    info.textContent = safeRead(() => layer.textItem.contents, null);
  }

  // Lock state. `allLocked` is the documented property; some builds also expose
  // the individual lock flags. A layer counts as locked if any lock is set.
  const allLocked = safeRead(() => layer.allLocked, undefined);
  info.locked = allLocked === true;

  if (SCAN_OPTIONS.includeLockDetail) {
    const detail = {
      all: allLocked === true,
      pixels: safeRead(() => layer.pixelsLocked, false) === true,
      position: safeRead(() => layer.positionLocked, false) === true,
      transparentPixels:
        safeRead(() => layer.transparentPixelsLocked, false) === true,
    };
    info.lockDetail = detail;
    info.locked =
      detail.all || detail.pixels || detail.position || detail.transparentPixels;
  }

  if (SCAN_OPTIONS.includeBounds) {
    const bounds = safeRead(() => layer.bounds, null);
    if (bounds) {
      const left = toNumber(bounds.left);
      const top = toNumber(bounds.top);
      const right = toNumber(bounds.right);
      const bottom = toNumber(bounds.bottom);
      info.bounds = { left, top, right, bottom };

      const boundsWidth = toNumber(bounds.width);
      const boundsHeight = toNumber(bounds.height);
      info.width =
        boundsWidth !== null
          ? boundsWidth
          : right !== null && left !== null
          ? right - left
          : null;
      info.height =
        boundsHeight !== null
          ? boundsHeight
          : bottom !== null && top !== null
          ? bottom - top
          : null;
    }
  }

  return info;
}

/**
 * Walks a list of Photoshop layers depth-first.
 * Top-level layers are depth 1, so "max nesting depth" reads the way a user
 * counts levels in the Layers panel.
 */
function walkLayers(layers, depth, parent, out) {
  const nodes = [];
  if (!layers) return nodes;

  for (const layer of layers) {
    const info = describeLayer(layer, depth, parent);
    out.flat.push(info);
    out.maxDepth = Math.max(out.maxDepth, depth);

    if (info.isGroup) {
      const children = safeRead(() => layer.layers, []) || [];
      info.children = walkLayers(children, depth + 1, info, out);
      info.childCount = info.children.length;
      info.hasChildren = info.childCount > 0;
    }

    nodes.push(info);
  }

  return nodes;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Returns the active document, or null when nothing is open.
 * `app.activeDocument` throws in some builds when no document exists, hence
 * the documents-length check first.
 */
function getActiveDocument() {
  try {
    if (!app.documents || app.documents.length === 0) return null;
    return app.activeDocument || null;
  } catch (err) {
    return null;
  }
}

/** Aggregate counts computed from the flat layer list (pure function). */
function buildStats(flat, maxDepth) {
  const stats = {
    totalLayers: flat.length,
    groups: 0,
    normalLayers: 0,
    hidden: 0,
    locked: 0,
    maxDepth,
    kinds: {},
  };

  for (const layer of flat) {
    if (layer.isGroup) stats.groups += 1;
    else stats.normalLayers += 1;
    if (!layer.visible) stats.hidden += 1;
    if (layer.locked) stats.locked += 1;
    stats.kinds[layer.kind] = (stats.kinds[layer.kind] || 0) + 1;
  }

  return stats;
}

function readDocumentInfo(doc) {
  return {
    id: safeRead(() => doc.id, null),
    name: String(safeRead(() => doc.name, "Untitled")),
    width: toNumber(safeRead(() => doc.width, null)),
    height: toNumber(safeRead(() => doc.height, null)),
  };
}

function documentUnavailable(cause) {
  const wrapped = new Error(
    "The document could not be read. It may have been closed during the scan."
  );
  wrapped.code = "DOCUMENT_UNAVAILABLE";
  wrapped.cause = cause;
  return wrapped;
}

/**
 * DOM traversal scan. Correct on every Photoshop build, but each property read
 * is a separate IPC call — roughly ten per layer.
 */
function scanViaDom(doc, documentInfo, started) {
  const out = { flat: [], maxDepth: 0 };

  let topLevel;
  try {
    topLevel = doc.layers || [];
  } catch (err) {
    throw documentUnavailable(err);
  }

  const tree = walkLayers(topLevel, 1, null, out);

  return {
    document: documentInfo,
    tree,
    layers: out.flat,
    stats: buildStats(out.flat, out.maxDepth),
    method: "dom",
    durationMs: Date.now() - started,
  };
}

/* ------------------------------------------------------------------ *
 * Fast scan (single batchPlay multiGet)
 * ------------------------------------------------------------------ */

/**
 * ActionManager's numeric `layerKind`. This is a DIFFERENT enumeration from the
 * DOM's LayerKind, so it gets its own map. Values are normalized to the same
 * strings the DOM path produces, keeping the analyzers unaware of which path ran.
 */
const AM_LAYER_KINDS = {
  1: "pixel",
  2: "adjustment",
  3: "text",
  4: "shape",
  5: "smartObject",
  6: "video",
  7: "group",
  8: "layer3D",
  9: "gradient",
  10: "pattern",
  11: "solidColor",
};

/** layerSection tells groups apart from their (hidden) closing divider. */
function sectionTypeOf(descriptor) {
  const section = descriptor.layerSection;
  const value = section && section._value ? String(section._value) : "";
  if (value === "layerSectionStart") return "start";
  if (value === "layerSectionEnd") return "end";
  return "content";
}

function lockingFromDescriptor(locking, includeDetail) {
  const source = locking || {};
  const detail = {
    all: source.protectAll === true,
    pixels: source.protectComposite === true,
    position: source.protectPosition === true,
    transparentPixels: source.protectTransparency === true,
  };
  const locked = includeDetail
    ? detail.all || detail.pixels || detail.position || detail.transparentPixels
    : detail.all;
  return { locked, detail: includeDetail ? detail : null };
}

function boundsFromDescriptor(bounds) {
  if (!bounds) return { bounds: null, width: null, height: null };

  const left = toNumber(bounds.left);
  const top = toNumber(bounds.top);
  const right = toNumber(bounds.right);
  const bottom = toNumber(bounds.bottom);

  return {
    bounds: { left, top, right, bottom },
    width: right !== null && left !== null ? right - left : null,
    height: bottom !== null && top !== null ? bottom - top : null,
  };
}

function descriptorToLayerInfo(descriptor, depth, parent, isGroup, options) {
  const locking = lockingFromDescriptor(
    descriptor.layerLocking,
    options.includeLockDetail
  );
  const box = boundsFromDescriptor(descriptor.bounds);
  const name = String(descriptor.name === undefined ? "" : descriptor.name);

  const info = {
    id: descriptor.layerID,
    name,
    kind: isGroup ? "group" : AM_LAYER_KINDS[descriptor.layerKind] || "unknown",
    isGroup,
    visible: descriptor.visible !== false,
    locked: locking.locked,
    lockDetail: locking.detail,
    // ActionManager reports opacity as 0–255; the DOM path reports 0–100.
    opacity:
      typeof descriptor.opacity === "number"
        ? Math.round((descriptor.opacity / 255) * 100)
        : null,
    depth,
    parentId: parent ? parent.id : null,
    parentName: parent ? parent.name : null,
    path: parent ? parent.path + " / " + name : name,
    childCount: 0,
    hasChildren: false,
    bounds: box.bounds,
    width: box.width,
    height: box.height,
    // multiGet returns the text object for text layers, so contents come free.
    textContent:
      descriptor.textKey && typeof descriptor.textKey.textKey === "string"
        ? descriptor.textKey.textKey
        : null,
    children: [],
  };

  // multiGet can return mask flags too, which saves the separate mask query.
  if ("hasUserMask" in descriptor || "hasVectorMask" in descriptor) {
    info.maskInfo = {
      unknown: false,
      hasUserMask: descriptor.hasUserMask === true,
      hasVectorMask: descriptor.hasVectorMask === true,
    };
  }

  return info;
}

const MULTIGET_PROPERTIES = [
  "name",
  "layerID",
  "layerKind",
  "layerSection",
  "visible",
  "opacity",
  "layerLocking",
  "bounds",
  "hasUserMask",
  "hasVectorMask",
  "textKey",
];

/**
 * Reads every layer property for the whole document in ONE batchPlay call.
 * The flat list comes back bottom-to-top, so it is walked in reverse (top-down,
 * matching the Layers panel): `layerSectionStart` opens a group and
 * `layerSectionEnd` closes it, which reconstructs the hierarchy without any
 * further Photoshop calls.
 *
 * Throws if the result cannot be trusted — the caller then falls back to the
 * DOM traversal, so a wrong guess here degrades to "slower" and never to "wrong".
 */
async function scanViaBatchPlay(doc, documentInfo, started, options) {
  const response = await batchPlay(
    [
      {
        _obj: "multiGet",
        _target: { _ref: "document", _id: documentInfo.id },
        extendedReference: [
          MULTIGET_PROPERTIES,
          { _obj: "layer", index: 0, count: -1 },
        ],
        options: { failOnMissingProperty: false, failOnMissingElement: false },
      },
    ],
    { synchronousExecution: false }
  );

  const list = response && response[0] && response[0].list;
  if (!Array.isArray(list) || !list.length) {
    throw new Error("multiGet returned no layer list");
  }

  const flat = [];
  const roots = [];
  const stack = [{ node: null, children: roots }];
  let maxDepth = 0;

  // Descending index == top of the Layers panel downwards.
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const descriptor = list[i];
    if (!descriptor || typeof descriptor.layerID !== "number") continue;

    const section = sectionTypeOf(descriptor);

    if (section === "end") {
      // The divider that closes a group. It is not a real layer.
      if (stack.length > 1) stack.pop();
      continue;
    }

    const frame = stack[stack.length - 1];
    const depth = stack.length;
    const info = descriptorToLayerInfo(
      descriptor,
      depth,
      frame.node,
      section === "start",
      options
    );

    flat.push(info);
    frame.children.push(info);
    if (depth > maxDepth) maxDepth = depth;

    if (section === "start") stack.push({ node: info, children: info.children });
  }

  flat.forEach((layer) => {
    layer.childCount = layer.children.length;
    layer.hasChildren = layer.childCount > 0;
  });

  // Cheap invariant: the reconstructed top level must match what the DOM says.
  // A mismatch means the section markers were interpreted wrongly on this build.
  const expectedRoots = safeRead(() => doc.layers.length, null);
  if (expectedRoots !== null && expectedRoots !== roots.length) {
    throw new Error(
      "multiGet hierarchy mismatch: expected " +
        expectedRoots +
        " top-level layers, built " +
        roots.length
    );
  }

  return {
    document: documentInfo,
    tree: roots,
    layers: flat,
    stats: buildStats(flat, maxDepth),
    method: "fast",
    durationMs: Date.now() - started,
  };
}

/**
 * Scans the active document into a snapshot:
 *   { document, tree, layers, stats, method, durationMs }
 *
 * Tries the single-call fast path first (unless disabled in Settings) and falls
 * back to DOM traversal if anything about the result looks wrong.
 * Throws when no document is open or the document goes away mid-scan.
 */
async function scanDocument(options) {
  const config = Object.assign(
    { fastScan: true, includeLockDetail: SCAN_OPTIONS.includeLockDetail },
    options || {}
  );

  const started = Date.now();
  const doc = getActiveDocument();

  if (!doc) {
    const err = new Error(
      "Open a Photoshop document before running LayerDoctor."
    );
    err.code = "NO_DOCUMENT";
    throw err;
  }

  const documentInfo = readDocumentInfo(doc);

  if (config.fastScan && documentInfo.id !== null) {
    try {
      return await scanViaBatchPlay(doc, documentInfo, started, config);
    } catch (err) {
      console.warn(
        "[LayerDoctor] Fast scan unavailable, falling back to DOM traversal:",
        (err && err.message) || err
      );
    }
  }

  SCAN_OPTIONS.includeLockDetail = config.includeLockDetail;
  return scanViaDom(doc, documentInfo, started);
}

/* ------------------------------------------------------------------ *
 * Mask enrichment (the one place batchPlay is needed)
 * ------------------------------------------------------------------ */

/**
 * The UXP DOM does not expose layer masks, so mask state has to come from a
 * batchPlay `get`. Only *candidate* empty layers are queried — typically a
 * handful — and all of them go out in a single batchPlay round trip.
 *
 * Sets `layer.maskInfo` on each candidate:
 *   { unknown: false, hasUserMask, hasVectorMask }  — trustworthy
 *   { unknown: true }                               — could not be determined
 *
 * `unknown: true` is deliberately never treated as "no mask". A layer whose mask
 * state cannot be proven is reported but never marked safe to delete.
 */
async function enrichMaskInfo(snapshot, layerIds) {
  const byId = new Map();
  snapshot.layers.forEach((layer) => byId.set(layer.id, layer));

  // The fast scan already returned mask flags, so only ask about what is missing.
  const ids = (layerIds || []).filter((id) => {
    if (typeof id !== "number") return false;
    const layer = byId.get(id);
    return !layer || !layer.maskInfo || layer.maskInfo.unknown === true;
  });
  if (!ids.length) return snapshot;

  const markUnknown = () => {
    ids.forEach((id) => {
      const layer = byId.get(id);
      if (layer) layer.maskInfo = { unknown: true };
    });
  };

  try {
    const commands = ids.map((id) => ({
      _obj: "get",
      _target: [{ _ref: "layer", _id: id }],
      _options: { dialogOptions: "dontDisplay" },
    }));

    const results = await batchPlay(commands, { synchronousExecution: false });

    ids.forEach((id, index) => {
      const layer = byId.get(id);
      if (!layer) return;

      const descriptor = results[index];
      // If Photoshop did not report the mask flags at all we cannot prove the
      // layer is unmasked, so treat it as unknown rather than assuming.
      const known =
        descriptor &&
        ("hasUserMask" in descriptor ||
          "hasVectorMask" in descriptor ||
          "userMaskEnabled" in descriptor);

      if (!known) {
        layer.maskInfo = { unknown: true };
        return;
      }

      layer.maskInfo = {
        unknown: false,
        hasUserMask: descriptor.hasUserMask === true,
        hasVectorMask: descriptor.hasVectorMask === true,
      };
    });

    if (results[0]) {
      // Property names vary between Photoshop builds; log once for debugging.
      console.log(
        "[LayerDoctor] Mask query keys:",
        Object.keys(results[0]).slice(0, 40).join(", ")
      );
    }
  } catch (err) {
    console.warn(
      "[LayerDoctor] Mask query failed; empty layers will be reported but not marked deletable.",
      err
    );
    markUnknown();
  }

  return snapshot;
}

/* ------------------------------------------------------------------ *
 * Debug helpers
 * ------------------------------------------------------------------ */

/** Renders the snapshot tree as indented text, for the panel and the console. */
function formatTree(nodes, indent) {
  const prefix = indent || "";
  const lines = [];

  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1;
    const branch = isLast ? "└ " : "├ ";
    const flags = [];
    if (!node.visible) flags.push("hidden");
    if (node.locked) flags.push("locked");

    lines.push(
      prefix +
        branch +
        node.name +
        "  [" +
        node.kind +
        (flags.length ? " · " + flags.join(", ") : "") +
        "]"
    );

    if (node.children && node.children.length) {
      lines.push(
        ...formatTree(node.children, prefix + (isLast ? "   " : "│  "))
      );
    }
  });

  return lines;
}

/** Structured console output — the Phase 1 debugging surface. */
function logSnapshot(snapshot) {
  console.log(
    "[LayerDoctor] Scanned \"" +
      snapshot.document.name +
      "\" in " +
      snapshot.durationMs +
      "ms via " +
      (snapshot.method === "fast" ? "batchPlay multiGet" : "DOM traversal") +
      " (" +
      snapshot.stats.totalLayers +
      " layers)"
  );
  console.log("[LayerDoctor] Stats:", JSON.stringify(snapshot.stats, null, 2));
  console.log(
    "[LayerDoctor] Layer tree:\n" + formatTree(snapshot.tree, "").join("\n")
  );
  console.log(
    "[LayerDoctor] Flat layer list:",
    snapshot.layers.map((l) => ({
      id: l.id,
      name: l.name,
      kind: l.kind,
      depth: l.depth,
      visible: l.visible,
      locked: l.locked,
      parent: l.parentName,
      width: l.width,
      height: l.height,
    }))
  );
}

module.exports = {
  SCAN_OPTIONS,
  getActiveDocument,
  scanDocument,
  enrichMaskInfo,
  buildStats,
  formatTree,
  logSnapshot,
};
