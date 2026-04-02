// src/services/dx-index.js — DX services barrel export
// Replaces quick-wins/index.js

export { getRandomTip } from './tips.js';
export { getActiveStylePrompt, listOutputStyles } from './output-styles.js';
export { buildCommitPrompt, gatherGitData } from './commit.js';
export { buildReviewPrompt } from './review.js';
export { buildDebugPrompt } from './debug.js';
export { runDoctor } from './doctor.js';
export { runInit } from './init-project.js';
