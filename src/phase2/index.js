// src/phase2/index.js — Phase 2 barrel export

// Context Compaction
export { runCompaction, buildCompactionRequest, formatCompactSummary, applyCompaction, createAutoCompactTracker } from './compaction.js';

// Typed Memory (user/feedback/project/reference)
export { MEMORY_TYPES, MEMORY_TYPE_DESCRIPTIONS, saveMemory, loadMemories, loadAllMemories, buildMemoryIndex, stalenessWarning } from './typed-memory.js';

// Session Notes (9-section template)
export { createSessionNotes, buildSessionNotesCompactSection } from './session-memory.js';
