/*
 * scoring.js — deterministic document health score.
 *
 * Pure functions only. The score is a plain arithmetic function of the issue
 * counts, so the same document always produces the same number and the
 * breakdown always reconciles with what the issue cards display.
 */

/** Penalty per offending item. Change these to retune the score. */
const SCORE_WEIGHTS = {
  badName: 1,
  duplicateName: 1,
  emptyLayer: 3,
  deepNesting: 2,
};

/** Issue id → weight key. Issues absent from this map do not affect the score. */
const ISSUE_WEIGHT_KEYS = {
  badNames: "badName",
  duplicateNames: "duplicateName",
  emptyLayers: "emptyLayer",
  deepNesting: "deepNesting",
};

/** Highest matching threshold wins; ordered high → low. */
const SCORE_STATUS = [
  { min: 90, label: "Excellent", tone: "excellent" },
  { min: 75, label: "Good", tone: "good" },
  { min: 50, label: "Needs Cleanup", tone: "warn" },
  { min: 0, label: "Critical", tone: "critical" },
];

function statusForScore(score) {
  for (const status of SCORE_STATUS) {
    if (score >= status.min) return status;
  }
  return SCORE_STATUS[SCORE_STATUS.length - 1];
}

/**
 * Starts at 100 and subtracts weighted penalties, floored at 0.
 * Hidden and locked layers are informational and carry no penalty.
 *
 * Returns { score, label, tone, totalPenalty, penalties[] } where each penalty
 * entry is { id, title, count, perItem, points } for display.
 */
function calculateScore(report, weights) {
  const w = Object.assign({}, SCORE_WEIGHTS, weights || {});
  const penalties = [];
  let totalPenalty = 0;

  report.issues.forEach((issue) => {
    const key = ISSUE_WEIGHT_KEYS[issue.id];
    if (!key || !issue.count) return;

    const perItem = w[key];
    const points = issue.count * perItem;
    totalPenalty += points;
    penalties.push({
      id: issue.id,
      title: issue.title,
      count: issue.count,
      perItem,
      points,
    });
  });

  const score = Math.max(0, Math.min(100, 100 - totalPenalty));
  const status = statusForScore(score);

  return {
    score,
    label: status.label,
    tone: status.tone,
    totalPenalty,
    penalties,
  };
}

function logScore(health) {
  console.log(
    "[LayerDoctor] Health score: " +
      health.score +
      "/100 (" +
      health.label +
      "), total penalty " +
      health.totalPenalty
  );
  health.penalties.forEach((p) => {
    console.log(
      "  -" + p.points + "  " + p.title + " (" + p.count + " × " + p.perItem + ")"
    );
  });
}

module.exports = {
  SCORE_WEIGHTS,
  SCORE_STATUS,
  ISSUE_WEIGHT_KEYS,
  statusForScore,
  calculateScore,
  logScore,
};
