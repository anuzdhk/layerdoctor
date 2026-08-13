/*
 * settings.js — local, account-free preference storage.
 *
 * Uses UXP's localStorage, which is scoped to the plugin and stays on the
 * machine. Nothing is uploaded and nothing is shared between documents.
 * Every read is defensive: corrupt or missing storage silently yields defaults.
 */

const analyzers = require("./analyzers.js");

const STORAGE_KEY = "layerdoctor.settings.v1";

const THRESHOLD_MIN = 2;
const THRESHOLD_MAX = 20;

/** Shape of the settings object, with the values used when nothing is stored. */
function defaults() {
  return {
    deepNestingThreshold: 5,
    badNameRules: analyzers.defaultBadNameRuleFlags(),
    fastScan: true,
    includeLockDetail: true,
  };
}

function clampThreshold(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return defaults().deepNestingThreshold;
  return Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, n));
}

/**
 * Merges stored values over the defaults, one key at a time, so a rule added in
 * a later version appears with its default rather than being dropped.
 */
function normalize(stored) {
  const result = defaults();
  if (!stored || typeof stored !== "object") return result;

  result.deepNestingThreshold = clampThreshold(stored.deepNestingThreshold);
  result.fastScan = stored.fastScan !== false;
  result.includeLockDetail = stored.includeLockDetail !== false;

  if (stored.badNameRules && typeof stored.badNameRules === "object") {
    Object.keys(result.badNameRules).forEach((ruleId) => {
      if (typeof stored.badNameRules[ruleId] === "boolean") {
        result.badNameRules[ruleId] = stored.badNameRules[ruleId];
      }
    });
  }

  return result;
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults();
    return normalize(JSON.parse(raw));
  } catch (err) {
    console.warn("[LayerDoctor] Could not read settings; using defaults.", err);
    return defaults();
  }
}

/** Returns the normalized settings that were actually persisted. */
function save(settings) {
  const normalized = normalize(settings);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch (err) {
    console.warn("[LayerDoctor] Could not save settings.", err);
  }
  return normalized;
}

function reset() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn("[LayerDoctor] Could not clear settings.", err);
  }
  return defaults();
}

module.exports = {
  STORAGE_KEY,
  THRESHOLD_MIN,
  THRESHOLD_MAX,
  defaults,
  clampThreshold,
  normalize,
  load,
  save,
  reset,
};
