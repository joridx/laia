// src/phase4/index.js — Phase 4 barrel export

export { createCoordinator, getCoordinatorPromptSection } from './coordinator.js';
export { runInBackground, getBackgroundAgent, listBackgroundAgents, getBackgroundResult, cleanupBackground, getEnhancedAgentParams } from './agent-enhancements.js';
export { registerAgent, unregisterAgent, sendMessage, checkMailbox, listAgents, getMailboxStatus, getSendMessageSchema, executeSendMessage } from './mailbox.js';
