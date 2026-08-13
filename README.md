# LayerDoctor

**Clean PSD. Clean Mind.**

A local, privacy-friendly PSD cleanup and auditing panel for Adobe Photoshop, built on the
modern UXP plugin architecture (manifest v5).

LayerDoctor scans the active Photoshop document, identifies layer-management problems,
calculates a document health score, and helps you fix the safe ones.

> **100% local.** No network requests, no accounts, no API keys, no AI services.
> Everything runs inside Photoshop and works offline.

---

## Status: complete (Phases 1–5)

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Panel, active-document detection, recursive layer scan, counts, max nesting depth, console tree | Done |
| 2 | Bad names, duplicate names, hidden layers, locked layers, issue cards + drill-down | Done |
| 3 | Empty layers, deep nesting, health score | Done |
| 4 | Rename tools, delete safe empty layers, show hidden, Fix Selected | Done |
| 5 | Settings, error handling, performance | Done |

### What Phase 5 adds

- **Settings screen** (the gear button in the header), stored locally in UXP `localStorage` — no
  account, no cloud, no file written outside the plugin's own storage:
  - **Deep nesting threshold**, clamped to 2–20.
  - **Bad-name detection toggles**, one per rule in `BAD_NAME_RULES`.
  - **Performance toggles** — fast scan on/off, detailed lock flags on/off.
  - `SAVE & RESCAN` applies immediately; `RESET TO DEFAULTS` restores and waits for save.

  Stored settings are merged key-by-key over the defaults, so a rule added in a future
  version appears at its default instead of vanishing, unknown keys are dropped, and
  corrupt storage falls back to defaults with a console warning.
- **Fast scan** — the whole document read in **one** `batchPlay` `multiGet` call instead of
  ~10 IPC property reads per layer. The flat list comes back bottom-to-top and the
  hierarchy is rebuilt from `layerSectionStart` / `layerSectionEnd` markers.
  It also returns mask flags, which removes the separate mask query entirely.

  **The fast path is validated, not trusted:** the reconstructed top-level count is
  checked against `doc.layers.length`, and any mismatch, throw, or empty result falls back
  to the Phase 1 DOM traversal with a console warning. A wrong guess degrades to *slower*,
  never to *wrong*. The results card and console both report which path ran.
- **Global error handlers** for `error` and `unhandledrejection`, so anything that escapes
  a `try/catch` still lands in the panel's notice strip and the panel leaves any
  busy/scanning state instead of freezing.

### What Phase 4 adds

Phase 4 is the first phase that **modifies** the document. Everything that writes lives in
`src/fixers.js`, split into pure planning and modal execution.

- **Safe Rename** with three deterministic strategies and a mandatory preview:
  - **Type + Number** — `Layer 23 → Pixel Layer 01`, `Rectangle 4 → Shape 01`,
    `Group 12 → Group 01`. Sequential per layer type.
  - **Custom Prefix** — `Hero 01`, `Hero 02`, `Hero 03`.
  - **Find and Replace** — case-insensitive, literal (regex metacharacters are escaped).

  Scope is Bad Names, Duplicates, or Photoshop's current layer selection. The preview
  updates as you type and lists every `old → new` pair; `APPLY` applies exactly that plan.
  No-op renames are dropped, and the planner avoids creating **new** duplicates by
  bumping the counter or appending a suffix.
- **Delete Empty Layers** — only the `safeToDelete` subset, behind a confirmation listing
  every layer by name and reason.
- **Show All Hidden Layers** — sets visibility on, undoable, never deletes.
- **Fix Selected** — a checkbox per issue card. Only empty-layer deletion runs
  automatically; renaming always routes through the preview, and hidden / deep-nesting
  open their review screens. Locked layers have no checkbox because there is no action.
- **Single-step Undo** — every mutation runs inside `core.executeAsModal()` wrapped in
  `hostControl.suspendHistory()` / `resumeHistory()`, so one Ctrl/Cmd+Z reverts the whole
  batch as `LayerDoctor: Rename Layers`, `LayerDoctor: Delete Empty Layers`, or
  `LayerDoctor: Show Hidden Layers`.
- **Layers are re-resolved by id at apply time.** A layer deleted between the scan and the
  apply is reported as *Layer no longer exists* rather than silently skipped, and one
  failure never aborts the rest of the batch. The document is rescanned after every
  mutation so the report can never drift from reality.

### What Phase 3 adds

- **Empty layers**, detected only with positive evidence:
  - an **empty group** (zero children), or
  - a **raster layer** (`pixel` / `normal` kind) with **zero-area bounds** and **no mask**.

  Adjustment layers, smart objects, text, fills, video and 3D are skipped outright —
  there is no safe way to prove those are empty from the DOM, so LayerDoctor does not try.
  Each finding carries `safeToDelete`; it is **false** for locked layers and for any layer
  whose mask state could not be verified. Nothing is deleted in Phase 3.
- **Deep nesting** — groups nested deeper than `deepNestingThreshold` (default **5**, in
  `DEFAULT_SETTINGS` in `src/analyzers.js`). Top-level is depth 1, so a group at depth 6
  is flagged.
- **Document health score** in `src/scoring.js`: starts at 100, subtracts
  `SCORE_WEIGHTS` × issue count, floored at 0. Bad name −1, duplicate −1, empty layer −3,
  deep nesting −2 each. Hidden and locked layers carry **no penalty**.
  Ranges: 90–100 Excellent, 75–89 Good, 50–74 Needs Cleanup, 0–49 Critical.
- **Score breakdown card** listing each penalty as `count × weight = −points`, so the
  number always reconciles with the issue cards above it.
- **One batchPlay call per scan.** Layer masks are the single thing the UXP DOM cannot
  report, so `scanner.enrichMaskInfo()` queries only the candidate empty layers, batched
  into one round trip. If it fails, those layers are still listed but never marked safe.

### What Phase 2 adds

- **Bad layer names** — regex rules in `src/analyzers.js`, no AI. Detects `Layer 1`,
  `Group 12`, `Rectangle 4`, `Ellipse 7`, `Shape 22`, `Layer 2 copy 4`, `Copy`, `asdf`,
  `test`, `Untitled`, blank names. Two extra rules ship **off by default**:
  `adjustmentDefaults` (`Levels 1`, `Color Fill 1`) and `singleCharacter`.
- **Duplicate names** — trimmed, whitespace-collapsed, case-insensitive comparison, so
  `Button` / `button` / `BUTTON` collide. Grouped by colliding name in the detail view.
  Nothing is renamed during a scan.
- **Hidden layers** (`visible === false`) and **locked layers** — reported as
  *informational*: they appear as cards but do not count toward the headline issue total,
  and nothing is deleted or unlocked.
- **Issue cards** with icon, title, count and a `›` chevron. Clicking a card opens a
  drill-down list of the affected layers with kind, depth, parent and the reason matched.
- Analysis runs on the snapshot from a single scan — no rescan per issue category.

### What Phase 1 does

- Loads as a Photoshop UXP panel called **LayerDoctor**.
- Detects whether a document is open, and reacts to open/close/select events.
- Recursively reads every layer and group at any nesting depth.
- Collects per layer: id, name, kind, visibility, lock state, opacity, depth, parent,
  bounds, width, height, child count.
- Reports Total Layers, Groups, non-group Layers, Hidden, Locked, and Max Nesting Depth.
- Renders the layer tree in the panel and logs a structured snapshot to the UXP console.
- Handles the no-document state and surfaces scan errors in the panel instead of crashing.

---

## Project structure

```
layerdoctor/
├── manifest.json      UXP manifest v5, single panel entry point
├── logo.svg           Wordmark shown in the panel header
├── icons/             16x16 monochrome SVG icons (one per issue category)
├── index.html         Panel markup and states
├── styles.css         Dark Photoshop-style panel styling
├── main.js            Panel state machine + DOM rendering
├── src/
│   ├── scanner.js     All Photoshop DOM reads → plain-JS snapshot (+ one batchPlay)
│   ├── analyzers.js   Pure analysis over the snapshot (no Photoshop calls)
│   ├── scoring.js     Pure health-score arithmetic
│   ├── fixers.js      Rename planning (pure) + all document mutations (modal)
│   └── settings.js    Local preference storage (UXP localStorage)
└── README.md
```

Modules use CommonJS (`require` / `module.exports`), which the Photoshop UXP runtime
supports reliably for local files. There is no build step, no bundler and no
dependencies — the files in the repository are the files Photoshop runs.

**Icons.** The panel uses no emoji. `logo.svg` is the header wordmark, and `icons/`
holds one 16×16 monochrome SVG per issue category plus the settings glyph, loaded through
`<img src="…">` — the form UXP renders most reliably. Colour is baked into each file
(`#c8c8c8`) because CSS cannot restyle an image's contents; the panel is dark-only, so a
single tone is enough. To restyle, edit the `fill` value in the SVG files.

| File | Used for |
| --- | --- |
| `icons/naming.svg` | Bad Layer Names |
| `icons/duplicate.svg` | Duplicate Names |
| `icons/empty.svg` | Empty Layers |
| `icons/hidden.svg` | Hidden Layers |
| `icons/locked.svg` | Locked Layers |
| `icons/nesting.svg` | Deep Nesting |
| `icons/reload.svg` | Header reload button |
| `icons/settings.svg` | Header settings button |
| `icons/copyright.svg` | Footer credit |

Every icon is built from `<path>` elements only. UXP's SVG renderer does not draw
`<circle>` / `<rect>` / `<ellipse>` reliably — the settings icon rendered as a blank
button until its circles were converted to arc paths.

**Separation of concerns:** `scanner.js` is the only file that talks to Photoshop.
It reads the document **once** into a lightweight snapshot; every analyzer added later
works on that snapshot rather than re-querying Photoshop per issue category.

---

## Requirements

- Adobe Photoshop 23.0 (2022) or newer. Photoshop 2023+ recommended.
- [Adobe UXP Developer Tool](https://developer.adobe.com/photoshop/uxp/2022/guides/devtool/)
  (install from the Creative Cloud desktop app → *All apps* → *UXP Developer Tool*).

---

## Load and test the plugin

1. **Install Photoshop** and launch it at least once.
2. **Install the Adobe UXP Developer Tool (UDT)** from the Creative Cloud desktop app.
3. **Open Photoshop.** UDT can only connect to a running Photoshop instance.
   In Photoshop, enable *Preferences → Plugins → Enable Developer Mode*, then restart Photoshop.
4. **Open UDT.** Confirm that Photoshop appears as a connected app in the top-right
   *Connected apps* area. If it does not, click the ⋯ menu → *Enable Photoshop Connection*.
5. **Add the plugin project:** click **Add Plugin**, then select this folder's
   `manifest.json`.
6. **Load the plugin:** on the LayerDoctor row, click **Load**.
   The status column should change to *Loaded*.
7. **Open the panel in Photoshop:** *Plugins → LayerDoctor → LayerDoctor*.
   (On older builds: *Window → Extensions → LayerDoctor*.)
   Dock the panel anywhere you like.
8. **Open a test PSD** (see below).
9. **Click `SCAN DOCUMENT`.** The panel shows the document statistics and the layer tree.
10. **Debug:** in UDT, click the ⋯ menu on the LayerDoctor row → **Debug**. A Chrome
    DevTools window opens showing the `[LayerDoctor]` console output: timing, stats JSON,
    the indented layer tree, and the flat layer list.

### Reloading after code changes

Edit any file, then in UDT click the ⋯ menu → **Reload** (or the reload icon).
No rebuild step exists — there is no bundler and there are no dependencies.

---

## Test document

Create a PSD manually in Photoshop with the structure below. It exercises every
detector across all phases, so build it once and reuse it.

```
Layer 1                      ← bad name (default "Layer #")
Layer 2                      ← bad name + duplicate
Layer 2                      ← duplicate of the above
Group 1                      ← bad group name
  Rectangle 4                ← bad name (shape default)
  Layer 7 copy               ← bad name ("copy")
Hidden Layer                 ← set visibility off (eye icon)
Empty Layer                  ← new empty pixel layer, no content
button                       ← duplicate of "Button"/"BUTTON" (case-insensitive)
Button
BUTTON
Locked Layer                 ← lock it (padlock icon in the Layers panel)
Header                       ← deep nesting chain, 6 levels
└── Components
    └── Buttons
        └── Primary
            └── State
                └── Content  ← a normal layer at depth 6
```

How to build it quickly:

1. **File → New**, any size (e.g. 1000 × 1000 px).
2. Add pixel layers with the *New Layer* button; Photoshop names them `Layer 1`, `Layer 2`, …
3. Duplicate a layer (Ctrl/Cmd+J) to produce a `copy` name, then rename it `Layer 7 copy`.
4. Draw a rectangle with the Rectangle tool to get a `Rectangle 4`-style shape layer.
5. Select layers and press Ctrl/Cmd+G to create `Group 1`.
6. For the deep chain: create a layer, group it, rename the group `Content`'s parent chain
   upward — group repeatedly (Ctrl/Cmd+G six times) and rename each group.
7. Toggle the eye icon off on `Hidden Layer`, and click the lock icon for `Locked Layer`.
8. Leave `Empty Layer` as a brand-new pixel layer with nothing painted on it.

### Verifying Phase 5 with this document

| Check | Expected |
| --- | --- |
| Reload button (beside the logo) | Rescans from any screen; disabled with no document open, while scanning, and during a confirmation |
| Gear button (beside the logo) | Opens Settings; `‹ Back` returns without saving |
| Footer | Reads `100% local • No files uploaded` above a copyright icon and `madebyanuz` |
| Scan meta line | Reads `Scanned N layers in Xms · fast scan`. If it says `DOM scan`, the console explains why the fast path was rejected |
| Console on scan | `Scanned "…" in Xms via batchPlay multiGet (N layers)` |
| Fast scan vs DOM | Toggle it off, save, rescan — **the layer tree, counts and score must be identical**, only slower |
| Deep nesting threshold → 3 | More groups flagged; the detail note reads *deeper than 3 levels*; score changes by −2 per group |
| Threshold `99` | Clamped to 20 on save |
| Enable `Adjustment defaults` | `Levels 1` and `Color Fill 1` become bad names |
| Disable `Layer #` | `Layer 1` / `Layer 2` stop being flagged |
| Close and reopen the panel | Settings survive (UXP localStorage) |
| `RESET TO DEFAULTS` | Controls revert; nothing applies until `SAVE & RESCAN` |
| Large document | A few hundred layers should scan in well under a second on the fast path |

Sanity-checked offline: thresholds 3/5/7 flag 3/2/1 groups from the same fixture;
`clampThreshold` maps `1→2`, `21→20`, `"8"→8`, `"abc"→5`; a stored `{layerNumber:false,
bogusRule:true}` yields `layerNumber:false`, `groupNumber:true` (default) and no
`bogusRule`; and a synthetic `multiGet` list rebuilds a 3-level hierarchy with the correct
depths, paths, group count and lock/visibility flags, while a deliberate top-level
mismatch falls back to the DOM path.

### Verifying Phase 4 with this document

| Check | Expected |
| --- | --- |
| Bad Names detail → `FIX ALL NAMES (n)` | Confirmation lists every `old → new` pair; `RENAME ALL` applies Type + Number naming to all of them in one undo step |
| Bad Names detail → `MORE RENAME OPTIONS` | Opens Safe Rename with the Bad Names scope preselected |
| Type + Number preview | `Layer 1 → Pixel Layer 01`, `Group 1 → Group 01`, `Rectangle 4 → Shape 01` |
| Prefix `Hero` | `Hero 01`, `Hero 02`, `Hero 03` … in scope order |
| Find `copy` → Replace `variant` | Only `Layer 7 copy` changes, to `Layer 7 variant`. Layers without a match are absent from the preview |
| Find with regex chars (`.`) | Treated literally — `A.B → A-B`, `AXB` untouched |
| `APPLY` | Layers renamed in Photoshop, panel rescans, notice reads *Renamed N layer(s).* |
| **Ctrl/Cmd+Z once** | Reverts the **entire** rename batch. History shows `LayerDoctor: Rename Layers` |
| `SELECTED` scope | Select 3 layers in Photoshop, reopen Safe Rename → scope button reads `SELECTED (3)` |
| Empty Layers detail → `DELETE EMPTY LAYERS (n)` | Confirmation screen lists each layer + reason; `CANCEL` returns without changes |
| Confirm delete | Only `safeToDelete` layers go; locked/unverified ones survive and remain listed |
| Ctrl/Cmd+Z after delete | Restores all deleted layers in one step |
| Hidden Layers detail → `SHOW ALL HIDDEN` | All hidden layers become visible; Hidden count drops to 0 on the rescan |
| Fix Selected with only Empty Layers ticked | Runs the confirm + delete flow, then rescans |
| Fix Selected with Bad Names ticked | Does **not** rename anything — opens Safe Rename and posts *review required* |
| Delete a layer in Photoshop, then Apply a stale plan | That entry reports *Layer no longer exists*; the other renames still apply |
| Locked Layers card | Has no checkbox (no action exists for it) |

### Verifying Phase 3 with this document

| Check | Expected |
| --- | --- |
| Health card | Large `NN / 100` with a status word, coloured by range, and an issue count below |
| Empty Layers | Flags `Empty Layer` (new, unpainted pixel layer). Does **not** flag `Levels 1`, `Color Fill 1`, text layers, or smart objects even though they have no pixels of their own |
| Add a layer mask to `Empty Layer` | It disappears from the Empty Layers list entirely |
| Lock `Empty Layer` | Still listed, but the detail row reads *kept (locked)* |
| Empty group | Create a group and delete its contents → listed as *Empty group · contains no layers* |
| Deep Nesting | `1 group` for the `Header → … → Content` chain if `Content` is a group at depth 6; `0` if the threshold is raised above 5 |
| Score breakdown card | Only appears when the score is below 100; rows read `Empty Layers (1 × 3)  −3` and sum to the total penalty |
| Clean document | A one-layer PSD named `Hero` scores `100 / 100 Excellent`, "No cleanup issues detected.", no breakdown card |
| Score arithmetic | `100 − (badNames + duplicates + 3×empty + 2×deepNesting)`, floored at 0. Hidden and locked never change it |
| UDT → Debug console | `[LayerDoctor] Mask query keys: …` then `Health score: NN/100 (Label)` with per-penalty lines |

Sanity-checked offline: 6 bad names + 2 duplicates + 4 empties + 1 deep group ⇒
`100 − 6 − 2 − 12 − 2 = 78` (**Good**). Boundary values 90/89/75/74/50/49 map to
Excellent / Good / Good / Needs Cleanup / Needs Cleanup / Critical.

### Verifying Phase 2 with this document

| Check | Expected |
| --- | --- |
| Bad Layer Names | Flags `Layer 1`, both `Layer 2`s, `Group 1`, `Rectangle 4`, `Layer 7 copy`. Does **not** flag `Hidden Layer`, `Empty Layer`, `Header`, `Background`, or (by default) `Levels 1` / `Color Fill 1` |
| Click the Bad Names card | Detail list shows each layer with the rule that matched (e.g. *Default "Layer #" name*) |
| Duplicate Names | `Button` / `button` / `BUTTON` reported as one set of 3; the two `Layer 2`s as a set of 2 |
| Duplicate detail view | Grouped under a `"Button" — 3 layers` header with each layer's full path |
| Hidden Layers | Matches the eye-toggled-off count; card is grey, not orange |
| Locked Layers | Matches the padlocked count; grey/informational |
| Headline count | Bad names + duplicates only — hidden and locked do **not** inflate it |
| Zero-count card | Shown greyed out with "None detected" and is not clickable |
| Click a layer in Photoshop while a detail view is open | Panel stays on the detail view (does not bounce back) |
| Switch to a different document | Panel returns to *"Ready to scan."* |
| UDT → Debug console | `[LayerDoctor] Analysis: N issue(s) found` followed by a per-category breakdown |

### Verifying Phase 1 with this document

| Check | Expected |
| --- | --- |
| Panel with no document open | *"No document open. Open a PSD to start scanning."*, scan button disabled |
| Open the test PSD | Panel switches to *"Ready to scan."* and shows the document name |
| Click `SCAN DOCUMENT` | Statistics appear; `Total Layers` matches the Layers panel (groups included) |
| `Groups` | Counts every group at any depth, not just top-level ones |
| `Hidden` | Matches the number of layers with the eye toggled off |
| `Max Nesting Depth` | `6` for the `Header → … → Content` chain (top level = depth 1) |
| Layer tree card | Shows the same hierarchy as Photoshop's Layers panel, with `hidden` / `locked` flags |
| Close the document while the panel is open | Panel returns to the no-document state automatically |
| UDT → Debug console | `[LayerDoctor] Scanned "…" in Nms`, stats JSON, indented tree, flat list |

---

## Known UXP limitations

- **Property reads are IPC calls.** Every `layer.name`, `layer.bounds`, etc. crosses into
  Photoshop — roughly ten per layer, so a ~500-layer document takes 1–3 seconds on the DOM
  path. The Phase 5 fast scan replaces all of it with a single `multiGet`.
- **`multiGet` returns a flat, bottom-to-top list.** Hierarchy has to be reconstructed from
  `layerSection` markers, and the closing `layerSectionEnd` dividers are real entries with
  their own layer ids that must not be emitted as layers. Because this depends on
  behaviour that varies by build, the result is validated against `doc.layers.length` and
  falls back to DOM traversal on any mismatch.
- **ActionManager's numeric `layerKind` is a different enumeration from the DOM's
  `LayerKind`.** Both are mapped to the same normalized strings so the analyzers never
  need to know which scan path ran. ActionManager also reports opacity as 0–255 where the
  DOM reports 0–100.
- **`layer.kind` varies by version.** Modern Photoshop returns strings (`"pixel"`,
  `"group"`, `"text"`, …); older builds returned a numeric enum. `normalizeKind()` handles
  both, and unknown values fall back to `"unknown"` rather than throwing.
- **Lock state is not uniformly exposed.** `allLocked` is the documented property;
  `pixelsLocked` / `positionLocked` / `transparentPixelsLocked` exist on most builds but
  are read defensively. A layer counts as locked when any lock flag is set.
- **Exotic layer types can throw on property access** (some 3D, video and linked smart
  object layers). Every read is wrapped, so one bad layer degrades to fallback values
  instead of aborting the scan.
- **CSS grid is unsupported in UXP.** The panel layout uses flexbox only.
- **Flex children shrink instead of scrolling.** A `flex-direction: column` container with
  a `max-height` squashes its children until they visually overlap, rather than letting the
  container scroll. Every row and card carries `flex-shrink: 0` (see the shared rule at the
  top of `styles.css`) — without it, long issue lists render on top of each other.
- **`<img>` needs explicit width AND height.** UXP does not reliably derive an SVG's
  intrinsic aspect ratio from `width: auto`, so the logo and every icon carry both
  dimensions in `styles.css`.
- **Emoji are avoided entirely.** Glyph coverage and colour rendering vary by platform and
  UXP build, and emoji cannot be restyled with CSS. SVG icons are used instead.
- **UXP's SVG renderer only handles `<path>` reliably.** `<circle>`, `<rect>` and friends
  can silently fail to draw, so every icon in `icons/` is path-only, with circles expressed
  as arc commands.
- **`classList.toggle(name, force)`** is unreliable in UXP, so the panel uses explicit
  `add` / `remove`.
- **Container `<div>`s do not reliably stack.** UXP does not apply plain block layout the
  way a browser does, so every stacking container in `styles.css` declares
  `display: flex; flex-direction: column` explicitly. Without it, a header's title and
  tagline render side by side.
- **Utility classes need `!important`.** `.hidden` sits before layout rules that also set
  `display`, and at equal specificity the later rule wins — which made every panel state
  render at once. `.hidden { display: none !important; }` is the fix.
- **The UXP DOM does not expose layer masks.** There is no `layer.hasLayerMask`, so mask
  state requires a batchPlay `get` on the layer descriptor (`hasUserMask` /
  `hasVectorMask`). This is the only place LayerDoctor uses batchPlay, and it queries
  candidate empty layers only, batched into one call. The descriptor keys are logged on
  each scan because the exact property names vary between Photoshop builds — if a build
  omits them, the layers degrade to "mask state unknown" and are never marked deletable
  rather than being wrongly assumed unmasked.
- **Zero-area bounds are the only reliable emptiness signal**, and it only means anything
  for raster layers. Adjustment layers and fills legitimately have no pixels of their own,
  which is exactly why they are excluded by kind rather than by bounds.
- **Photoshop's `select` notification fires for layer selection, not just documents.**
  The listener compares document ids and ignores no-op events, otherwise clicking a layer
  in Photoshop would reset the panel out of a detail view.
- **Reading does not require modal execution**, but every write does. All mutations go
  through `core.executeAsModal()`; Photoshop rejects a modal while another one (or a
  dialog) is open, which surfaces in the panel as *"Photoshop is busy with another
  operation."* rather than an unhandled rejection.
- **`suspendHistory` is best-effort.** If it is unavailable the edits still apply — they
  just undo one layer at a time instead of as a single step. That is logged, not fatal.
- **Confirmations are rendered in-panel, not as UXP modal dialogs.** `uxpShowModal()`
  exists, but keeping every prompt and error inside the panel means there is exactly one
  surface that can never fail to open.
- **There is no flat layer accessor in the DOM.** Re-resolving a layer by id at apply time
  requires walking `doc.layers` recursively, so each mutation does one traversal reading
  only `.id` and `.layers`.

---

## Settings

Open with the gear button in the panel header.

| Setting | Default | Effect |
| --- | --- | --- |
| Deep nesting threshold | `5` | Groups deeper than this are flagged (clamped 2–20) |
| Blank names | on | Flags layers with an empty name |
| Layer # | on | Flags `Layer 1`, `Layer 23` |
| Group # | on | Flags `Group 1`, `Group 12` |
| Shape defaults | on | Flags `Rectangle 4`, `Ellipse 7`, `Shape 22` |
| "copy" names | on | Flags `Copy`, `Layer 2 copy 4` |
| Placeholder names | on | Flags `asdf`, `test`, `Untitled`, `temp`, `wip` |
| Adjustment defaults | **off** | Flags `Levels 1`, `Color Fill 1` |
| Single-character names | **off** | Flags `A`, `1` |
| Fast scan | on | One `batchPlay multiGet` instead of per-property DOM reads |
| Detailed lock flags | on | Reads all four lock flags, not just `allLocked` |

Settings live in UXP `localStorage` under `layerdoctor.settings.v1`, scoped to the plugin
on this machine. Nothing is uploaded and nothing is shared between documents.

## Privacy

LayerDoctor sends no document information anywhere. It makes no external API calls,
requires no account and no API key, requests no network permission in its manifest,
performs all analysis locally, and works fully offline. The only persisted data is the
settings object above.
