// src/quick-wins/index.js — Quick wins barrel export + integration helpers

export { getRandomTip, resetTips, initTipsFile } from './tips.js';
export { loadOutputStyles, getActiveStylePrompt, listOutputStyles, initOutputStyles } from './output-styles.js';
export { buildCommitPrompt, gatherGitData } from './commit.js';
export { buildReviewPrompt } from './review.js';
export { buildDebugPrompt } from './debug.js';
