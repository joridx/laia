// src/repl/slash-commands.js
// Slash command dispatch — extracted from repl.js
// Each command handler returns true (handled) or false.

import { stderr } from 'process';
import { detectProvider, getProvider, isProviderAvailable, PROVIDERS, resolveUrl, buildAuthHeaders } from '@laia/providers';
import { getProviderToken } from '../auth.js';
import { expandCommand, listSkills, loadSkill } from '../skills.js';
import { brainReflectSession } from '../brain/client.js';
import { getRandomTip, buildCommitPrompt, gatherGitData, buildReviewPrompt, buildDebugPrompt, listOutputStyles } from '../services/dx-index.js';
import { buildCompactionRequest, formatCompactSummary, applyCompaction } from '../services/compaction.js';
import { MEMORY_TYPES, saveMemory, loadMemories, loadAllMemories } from '../memory/typed-memory.js';
import { getOwner, OWNERSHIP_MATRIX } from '../memory/ownership.js';
import { getMemoryStats } from '../memory/unified-view.js';
import { createCoordinator } from '../coordinator/coordinator.js';
import { listBackgroundAgents, getBackgroundResult } from '../coordinator/background.js';
import { normalizeEffort } from '../config.js';
import { saveSession, autoSave, loadSession, listSessions, forkSession as forkSessionFn } from '../session.js';
import { loadProfile, listProfiles } from '../profiles.js';
import { executeTurn } from './turn-runner.js';
import { loadEvolvedIndex, loadEvolvedSplit, promoteEntry, demoteEntry, expireEntry, compileEvolvedPrompt, getEvolvedVersion } from '../evolved-prompt.js';
import { formatBudgetStats, detectConflicts } from '../memory/prompt-governance.js';
import { getPromptStats } from '../system-prompt.js';
import { createPlanEngine, displayPlan, displayProgress } from '../services/plan-engine.js';

// --- Command metadata for autocomplete + help ---
export const COMMAND_META = {
  '/save':       { desc: 'Save session',                  cat: 'session',  subs: [] },
  '/load':       { desc: 'Restore session',                cat: 'session',  subs: ['autosave'] },
  '/sessions':   { desc: 'List saved sessions',            cat: 'session',  subs: [] },
  '/fork':       { desc: 'Fork current session',           cat: 'session',  subs: [] },
  '/clear':      { desc: 'Clear history',                  cat: 'session',  subs: [] },
  '/compact':    { desc: 'Compact history',                cat: 'session',  subs: [] },
  '/model':      { desc: 'Change model',                   cat: 'config',   subs: ['auto', 'gemini-2.5-flash', 'cerebras:qwen-3-235b-a22b-instruct-2507', 'llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct', 'claude-opus-4.6', 'gpt-5.3-codex'] },
  '/effort':     { desc: 'Set reasoning effort',           cat: 'config',   subs: ['low', 'medium', 'high', 'max'] },
  '/plan':       { desc: 'Plan mode (generate structured plan)', cat: 'config', subs: ['show', 'edit', 'discard'] },
  '/approve':    { desc: 'Approve and execute plan',       cat: 'config',   subs: [] },
  '/execute':    { desc: 'Back to normal mode',            cat: 'config',   subs: [] },
  '/tokens':     { desc: 'Token usage & context stats',    cat: 'config',   subs: [] },
  '/attach':     { desc: 'Attach file to context',         cat: 'files',    subs: [] },
  '/detach':     { desc: 'Detach file from context',       cat: 'files',    subs: ['all'] },
  '/attached':   { desc: 'List attached files',            cat: 'files',    subs: [] },
  '/agents':     { desc: 'Agent profiles',                 cat: 'agents',   subs: ['show', 'validate', 'create'] },
  '/swarm':      { desc: 'Toggle swarm mode',              cat: 'agents',   subs: [] },
  '/skills':     { desc: 'List all skills',                cat: 'skills',   subs: [] },
  '/help':       { desc: 'Show this help',                 cat: 'system',   subs: [] },
  '/commit':     { desc: 'Generate commit from changes',   cat: 'git',      subs: [] },
  '/review':     { desc: 'Code review a Pull Request',     cat: 'git',      subs: [] },
  '/debug':      { desc: 'Diagnose session issues',         cat: 'system',   subs: [] },
  '/style':      { desc: 'Set/list output styles',          cat: 'config',   subs: ['list'] },
  '/tip':        { desc: 'Show a random tip',               cat: 'system',   subs: [] },
  '/reflect':    { desc: 'Reflect on session and extract insights', cat: 'system', subs: [] },
  '/evolve':     { desc: 'Manage evolved prompt (budget, promote, demote)', cat: 'system', subs: ['list', 'budget', 'promote', 'demote', 'expire', 'conflicts', 'recompile'] },
  '/memory':     { desc: 'Typed memories (user/feedback/project/ref)',  cat: 'system', subs: ['list', 'add', 'types'] },
  '/coordinator': { desc: 'Toggle coordinator mode (4-phase)',  cat: 'agents',   subs: ['on', 'off', 'status'] },
  '/tasks':       { desc: 'List/check background agents',     cat: 'agents',   subs: ['get'] },
  '/autocommit': { desc: 'Toggle git auto-commit',         cat: 'system',   subs: [] },
  '/undo':       { desc: 'Revert changes (--list, N)',     cat: 'system',   subs: ['--list', '-l'] },
  '/doctor':     { desc: 'Run diagnostics',                cat: 'system',   subs: [] },
  '/sleep':      { desc: 'Run sleep cycle (memory consolidation)', cat: 'system', subs: [] },
  '/talk':       { desc: 'Talk integration (poll, send, rooms)', cat: 'nextcloud', subs: ['poll', 'send', 'rooms'] },
  '/cron':       { desc: 'CRON.md scheduled jobs',           cat: 'nextcloud', subs: ['list'] },
  '/confirm':    { desc: 'Pending confirmations',            cat: 'nextcloud', subs: ['list', 'approve', 'deny'] },
  '/nc-tasks':   { desc: 'TASKS.md task list',               cat: 'nextcloud', subs: ['list', 'pending'] },
  '/status':     { desc: 'System health dashboard',        cat: 'system',   subs: [] },
  '/flags':      { desc: 'View/set feature flags',         cat: 'config',   subs: ['set'] },
  '/skillify':   { desc: 'Capture session as reusable skill', cat: 'skills',   subs: ['--force'] },
  '/init':       { desc: 'Generate LAIA.md for project',   cat: 'system',   subs: ['--force', '--dry-run'] },
  '/reflect':    { desc: 'Reflect on session (brain LLM)',  cat: 'system',   subs: ['auto'] },
  '/paste':      { desc: 'Multi-line input (BPM fallback)', cat: 'system',  subs: [] },
  '/exit':       { desc: 'Exit LAIA',                      cat: 'system',   subs: [] },
  '/quit':       { desc: 'Exit LAIA',                      cat: 'system',   subs: [] },
};

export const BUILTIN_COMMANDS = Object.keys(COMMAND_META);

const CATEGORY_LABELS = {
  session: '📦 Session',
  config:  '🔧 Config',
  git:     '🔀 Git',
  files:   '📎 Files',
  agents:  '🤖 Agents',
  skills:  '🎯 Skills',
  nextcloud: '☁️ Nextcloud',
  system:  '⚙️  System',
};

export function formatTokenCount(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

/**
 * Handle a slash command. Returns true if handled.
 * @param {string} input - Full input line starting with /
 * @param {object} session - Session state bundle
 */
export async function handleSlashCommand(input, session) {
  const { config, logger, context, fileCommands, attachManager, autoCommitter, undoStack, planCtrl, effortCtrl, sessionTokens, planEngine } = session;

  const spaceIdx = input.indexOf(' ');
  const name = (spaceIdx === -1 ? input.slice(1) : input.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : input.slice(spaceIdx + 1).trim();

  switch (name) {
    case 'help': {
      const DIM = '\x1b[2m';
      const R = '\x1b[0m';
      const B = '\x1b[1m';
      const C = '\x1b[36m';
      const G = '\x1b[32m';

      const groups = {};
      for (const [cmd, meta] of Object.entries(COMMAND_META)) {
        if (cmd === '/quit') continue;
        const cat = meta.cat;
        if (!groups[cat]) groups[cat] = [];
        const subs = meta.subs.length ? ` ${DIM}<${meta.subs.join('|')}>${R}` : '';
        groups[cat].push(`  ${B}${cmd}${R}${subs}${' '.repeat(Math.max(1, 22 - cmd.length - (subs ? meta.subs.join('|').length + 3 : 0)))}${DIM}${meta.desc}${R}`);
      }

      stderr.write('\n');
      for (const [cat, label] of Object.entries(CATEGORY_LABELS)) {
        if (!groups[cat]) continue;
        stderr.write(`${C}${label}${R}\n`);
        for (const line of groups[cat]) stderr.write(line + '\n');
        stderr.write('\n');
      }

      const skillNames = [...fileCommands.keys()];
      if (skillNames.length) {
        stderr.write(`${C}\ud83c\udfaf Skills (${skillNames.length})${R}\n`);
        const cols = stderr.columns || process.stdout.columns || 80;
        const perRow = Math.max(1, Math.floor(cols / 22));
        for (let i = 0; i < skillNames.length; i += perRow) {
          const row = skillNames.slice(i, i + perRow).map(k => `  ${G}/${k}${R}`);
          stderr.write(row.join('') + '\n');
        }
        stderr.write('\n');
      }
      stderr.write(`${DIM}Tip: Tab to autocomplete commands + subcommands. After a response, Tab to cycle suggestions.${R}\n`);
      return true;
    }

    case 'model':
      await handleModelCommand(args, config);
      return true;

    case 'clear':
      context.clear();
      console.log('History cleared.');
      return true;

    case 'compact': {
      const turns = context.turnCount();
      const tokensBefore = context.estimateTokens();

      if (turns <= 2) {
        stderr.write('\x1b[33mToo few turns to compact.\x1b[0m\n');
        return true;
      }

      stderr.write(`\x1b[2m[compact] ${turns} turns, ~${tokensBefore} tokens → LLM summary (9 sections)...\x1b[0m\n`);

      try {
        // Build compaction request
        const { messages: compactMsgs } = buildCompactionRequest(context);

        // Run a dedicated turn just for compaction
        const compactResult = await executeTurn({
          input: compactMsgs[compactMsgs.length - 1].content,
          config,
          logger,
          context,
          undoStack,
          autoCommitter,
          planMode: true,
          effort: 'high',
        });

        const raw = compactResult?.assistantText || '';
        const summary = formatCompactSummary(raw);

        if (summary && summary.length >= 50) {
          applyCompaction(context, summary);
          const tokensAfter = context.estimateTokens();
          const pct = tokensBefore > 0 ? Math.round((1 - tokensAfter / tokensBefore) * 100) : 0;
          stderr.write(`\x1b[32m[compact] ✅ ${tokensBefore} → ${tokensAfter} tokens (${pct}% reduction, ${turns} → ${context.turnCount()} turns)\x1b[0m\n`);
        } else {
          stderr.write('\x1b[33m[compact] LLM summary too short, falling back to simple compaction\x1b[0m\n');
          context.compact();
        }
      } catch (err) {
        stderr.write(`\x1b[33m[compact] LLM failed (${err.message}), falling back to simple compaction\x1b[0m\n`);
        context.compact();
      }
      return true;
    }

    case 'exit':
    case 'quit':
      // Signal repl to close readline → triggers rl.on('close') with full cleanup
      // (auto-save, reflection pipeline, brain_log_session, stopBrain)
      return { exitRequested: true };

    case 'save': {
      if (context.turnCount() === 0) {
        stderr.write('\x1b[33mNothing to save (no turns yet)\x1b[0m\n');
        return true;
      }
      const meta = { sessionId: '', model: config.model, workspaceRoot: config.workspaceRoot, name: args || '' };
      try {
        const filepath = saveSession(context.serialize(), meta);
        stderr.write(`\x1b[32m✓ Session saved: ${filepath}\x1b[0m\n`);
      } catch (err) {
        stderr.write(`\x1b[31mFailed to save: ${err.message}\x1b[0m\n`);
      }
      return true;
    }

    case 'load': {
      const target = args || null;
      let data;
      if (!target) {
        const { loadAutoSave } = await import('../session.js');
        data = loadAutoSave();
        if (!data) { stderr.write('\x1b[33mNo autosave found\x1b[0m\n'); return true; }
      } else {
        data = loadSession(target);
      }
      if (!data) {
        stderr.write(`\x1b[33mSession not found: ${target}\x1b[0m\n`);
        return true;
      }
      if (data.error === 'ambiguous') {
        stderr.write('\x1b[33mAmbiguous match. Candidates:\x1b[0m\n');
        data.candidates.forEach(c => stderr.write(`  ${c}\n`));
        return true;
      }
      if (data.error) {
        stderr.write(`\x1b[31mCannot load: ${data.error} — ${data.message ?? ''}\x1b[0m\n`);
        return true;
      }
      const ok = context.deserialize(data);
      if (ok) {
        stderr.write(`\x1b[32m✓ Loaded ${data.turns?.length ?? 0} turns (from ${data.createdAt ?? '?'})\x1b[0m\n`);
      } else {
        stderr.write('\x1b[31mFailed to deserialize session\x1b[0m\n');
      }
      return true;
    }

    case 'sessions': {
      const sessions = listSessions(15);
      if (!sessions.length) {
        stderr.write('\x1b[2mNo saved sessions\x1b[0m\n');
        return true;
      }
      stderr.write('\x1b[1mSaved sessions:\x1b[0m\n');
      for (const s of sessions) {
        const date = s.createdAt !== '?' ? s.createdAt.replace('T', ' ').slice(0, 19) : '?';
        stderr.write(`  \x1b[36m${String(s.index).padStart(2)}\x1b[0m  ${date}  ${String(s.turns).padStart(3)} turns  ${s.model}  \x1b[2m${s.file}\x1b[0m\n`);
      }
      stderr.write('\x1b[2mUse /load <number> or /load <name> to restore\x1b[0m\n');
      return true;
    }

    case 'attach': {
      if (!args) {
        stderr.write('\x1b[33mUsage: /attach <path|glob>\x1b[0m\n');
        return true;
      }
      const results = attachManager.attach(args);
      for (const r of results) {
        if (r.ok) {
          const label = r.image ? '🖼' : '✓';
          stderr.write(`\x1b[32m${label} ${r.name} (${(r.size / 1024).toFixed(1)}KB)\x1b[0m\n`);
        } else {
          stderr.write(`\x1b[31m✗ ${r.path}: ${r.error}\x1b[0m\n`);
        }
      }
      if (attachManager.count() > 0) {
        stderr.write(`\x1b[2m[${attachManager.count()} files attached, ~${attachManager.estimateTokens()} tokens]\x1b[0m\n`);
      }
      return true;
    }

    case 'detach': {
      if (!args) {
        stderr.write('\x1b[33mUsage: /detach <path|name|number|all>\x1b[0m\n');
        return true;
      }
      const result = attachManager.detach(args);
      if (result === 'ambiguous') {
        stderr.write('\x1b[33mAmbiguous name — use /attached to see indices, then /detach <number>\x1b[0m\n');
      } else if (result) {
        stderr.write(`\x1b[32m✓ Detached. ${attachManager.count()} files remaining.\x1b[0m\n`);
      } else {
        stderr.write('\x1b[33mNot found. Use /attached to see current attachments.\x1b[0m\n');
      }
      return true;
    }

    case 'autocommit': {
      autoCommitter.enabled = !autoCommitter.enabled;
      stderr.write(`📝 Auto-commit ${autoCommitter.enabled ? 'ON' : 'OFF'}\n`);
      return true;
    }

    case 'plan': {
      const normalizedArgs = String(args ?? '').trim();
      const sub = normalizedArgs.length ? normalizedArgs.split(/\s+/)[0].toLowerCase() : '';

      // /plan show — display current plan
      if (sub === 'show') {
        displayPlan(planEngine?.getPlan());
        return true;
      }

      // /plan discard — discard active plan
      if (sub === 'discard') {
        if (planEngine?.discard()) {
          stderr.write('\x1b[33m🗑️  Plan discarded.\x1b[0m\n');
        } else {
          stderr.write('\x1b[33mNo active plan to discard.\x1b[0m\n');
        }
        return true;
      }

      // /plan edit <text> — re-generate plan with modifications
      if (sub === 'edit') {
        if (!planEngine?.getPlan()) {
          stderr.write('\x1b[33mNo active plan. Use /plan <prompt> to create one.\x1b[0m\n');
          return true;
        }
        const editPrompt = args.slice(4).trim();
        if (!editPrompt) {
          stderr.write('\x1b[33mUsage: /plan edit <what to change>\x1b[0m\n');
          return true;
        }
        const currentPlan = planEngine.getPlan();
        const modifyInput = `Modify the following plan based on this request: "${editPrompt}"\n\nCurrent plan:\n${currentPlan.rawSource}\n\nOutput the full modified plan in the same JSON format.`;
        planCtrl.setPlanMode?.(true);
        const editResult = await executeTurn({
          input: modifyInput, config, logger, context, undoStack, autoCommitter,
          planMode: true, effort: null,
        });
        if (editResult?.text) {
          const newPlan = planEngine.setPlan(editResult.text, currentPlan.title);
          newPlan.version = currentPlan.version + 1;
          stderr.write(`\x1b[32m📋 Plan updated to v${newPlan.version} (hash: ${newPlan.hash})\x1b[0m\n`);
          displayPlan(newPlan);
        }
        planCtrl.setPlanMode?.(false);
        return true;
      }

      // /plan (no args) — toggle read-only mode
      if (!normalizedArgs) {
        if (planCtrl.getPlanMode?.()) {
          stderr.write('\x1b[33mAlready in plan mode. Use /execute to switch back.\x1b[0m\n');
        } else {
          planCtrl.setPlanMode?.(true);
          stderr.write('\x1b[33m🔒 Plan mode ON — read-only (write/edit/bash disabled)\x1b[0m\n');
        }
        return true;
      }

      // /plan <prompt> — generate a structured plan
      planCtrl.setPlanMode?.(true);
      stderr.write('\x1b[33m🔒 Plan mode — generating structured plan...\x1b[0m\n');
      const planResult = await executeTurn({
        input: `Create a structured plan for: ${normalizedArgs}`, config, logger, context, undoStack, autoCommitter,
        planMode: true, effort: null,
      });
      if (planResult?.text) {
        const plan = planEngine?.setPlan(planResult.text, normalizedArgs);
        if (plan) {
          stderr.write('\n');
          displayPlan(plan);
        }
      }
      planCtrl.setPlanMode?.(false);
      return true;
    }

    case 'approve': {
      if (!planEngine?.getPlan()) {
        stderr.write('\x1b[33mNo active plan. Use /plan <prompt> to create one.\x1b[0m\n');
        return true;
      }

      const plan = planEngine.getPlan();
      if (plan.status === 'done') {
        stderr.write('\x1b[33mPlan already completed.\x1b[0m\n');
        return true;
      }
      if (plan.status === 'executing') {
        stderr.write('\x1b[33mPlan is already executing.\x1b[0m\n');
        return true;
      }

      // Parse step range: /approve 1-3, /approve 2,4,5, /approve (all)
      let stepIds = null;
      if (args) {
        stepIds = [];
        for (const part of args.split(/[,\s]+/)) {
          const range = part.match(/^(\d+)-(\d+)$/);
          if (range) {
            const start = parseInt(range[1], 10);
            const end = parseInt(range[2], 10);
            for (let i = start; i <= end; i++) stepIds.push(i);
          } else if (/^\d+$/.test(part)) {
            stepIds.push(parseInt(part, 10));
          }
        }
        if (stepIds.length === 0) stepIds = null;
      }

      const result = planEngine.approve(stepIds);
      if (result.error) {
        stderr.write(`\x1b[33m${result.error}\x1b[0m\n`);
        return true;
      }

      stderr.write(`\x1b[32m✅ Plan approved! Executing ${stepIds ? stepIds.length + ' steps' : 'all steps'}...\x1b[0m\n\n`);

      // Execute steps sequentially
      let step;
      while ((step = planEngine.nextStep()) !== null) {
        planEngine.startStep(step.id);
        displayProgress(planEngine.getPlan());
        stderr.write('\n');

        const stepPrompt = planEngine.buildStepPrompt(step.id);
        try {
          const stepResult = await executeTurn({
            input: stepPrompt, config, logger, context, undoStack, autoCommitter,
            planMode: false, effort: null,
          });

          if (stepResult?.text) {
            planEngine.completeStep(step.id);
          } else {
            planEngine.failStep(step.id, 'Empty response');
            stderr.write(`\x1b[33m⚠️  Step ${step.id} failed. Continue? (use /approve to retry remaining)\x1b[0m\n`);
            break;
          }
        } catch (err) {
          planEngine.failStep(step.id, err.message?.slice(0, 100) || 'Unknown error');
          stderr.write(`\x1b[31m❌ Step ${step.id} failed: ${err.message?.slice(0, 80)}\x1b[0m\n`);
          break;
        }
      }

      // Final summary
      stderr.write('\n');
      displayProgress(planEngine.getPlan());
      const progress = planEngine.getProgress();
      if (progress.failed > 0) {
        stderr.write(`\n\x1b[33m⚠️  ${progress.done}/${progress.total} steps completed, ${progress.failed} failed.\x1b[0m\n`);
      } else {
        stderr.write(`\n\x1b[32m🎉 Plan completed! ${progress.done}/${progress.total} steps done.\x1b[0m\n`);
      }
      return true;
    }

    case 'execute': {
      if (!planCtrl.getPlanMode?.()) {
        stderr.write('\x1b[33mAlready in execute mode.\x1b[0m\n');
      } else {
        planCtrl.setPlanMode?.(false);
        stderr.write('\x1b[32m🔓 Execute mode ON — all tools available\x1b[0m\n');
      }
      return true;
    }

    case 'effort': {
      if (!args) {
        const current = effortCtrl.getEffort?.() || 'default (none)';
        stderr.write(`🧠 Current effort: ${current}\n`);
        stderr.write('Usage: /effort <low|medium|high|max>\n');
      } else {
        try {
          const normalized = normalizeEffort(args);
          effortCtrl.setEffort?.(normalized);
          stderr.write(`🧠 Effort set to: ${normalized}\n`);
        } catch (e) {
          stderr.write(`\x1b[33m${e.message}\x1b[0m\n`);
        }
      }
      return true;
    }

    case 'fork': {
      const serialized = context.serialize();
      if (serialized?.turns?.length > 0) {
        const savedPath = saveSession(serialized, { model: config.model, workspaceRoot: config.workspaceRoot });
        stderr.write(`\x1b[2m[session] Pre-fork saved: ${savedPath}\x1b[0m\n`);
      }
      const { randomBytes } = await import('crypto');
      const oldId = context._sessionId || 'unknown';
      const newId = randomBytes(8).toString('hex');
      context._sessionId = newId;
      stderr.write(`\x1b[32m🔀 Forked session: ${oldId.slice(0,8)}... → ${newId.slice(0,8)}...\x1b[0m\n`);
      return true;
    }

    case 'skills': {
      const sub = args.split(/\s+/)[0]?.toLowerCase() || '';
      const subArg = args.split(/\s+/).slice(1).join(' ').trim();

      if (sub === 'show') {
        if (!subArg) { stderr.write('Usage: /skills show <name>\n'); return true; }
        const skill = loadSkill(subArg, { force: true });
        if (!skill) { stderr.write(`Skill '${subArg}' not found\n`); return true; }
        stderr.write(`\n📦 ${skill.name} [${skill.source}]\n`);
        stderr.write(`  Description: ${skill.description}\n`);
        stderr.write(`  Schema: ${skill.schema}\n`);
        stderr.write(`  Invocation: ${skill.invocation}\n`);
        stderr.write(`  Context: ${skill.context}\n`);
        stderr.write(`  Arguments: ${skill.arguments} ${skill.argumentHint ? `(${skill.argumentHint})` : ''}\n`);
        if (skill.allowedTools.length) stderr.write(`  Allowed tools: ${skill.allowedTools.join(', ')}\n`);
        if (skill.tags.length) stderr.write(`  Tags: ${skill.tags.join(', ')}\n`);
        if (skill.skillDir) stderr.write(`  Directory: ${skill.skillDir}\n`);
        stderr.write(`  Source: ${skill.sourceFile}\n`);
        if (skill.warnings.length) stderr.write(`  ⚠️ Warnings: ${skill.warnings.join('; ')}\n`);
        stderr.write(`  Body: ${skill.body.length} chars\n`);
      } else {
        const skills = listSkills({ force: true });
        if (skills.length === 0) {
          stderr.write('No skills found.\n');
          return true;
        }
        const v3Count = skills.filter(s => s.source === 'v3').length;
        const legacyCount = skills.filter(s => s.source === 'legacy').length;
        stderr.write(`\n📦 Skills (${v3Count} v3, ${legacyCount} legacy)\n\n`);
        const maxName = Math.max(6, ...skills.map(s => s.name.length));
        stderr.write(`  ${'Name'.padEnd(maxName)}  Source  Description\n`);
        stderr.write(`  ${''.padEnd(maxName, '─')}  ${''.padEnd(6, '─')}  ${''.padEnd(40, '─')}\n`);
        for (const s of skills.sort((a, b) => a.name.localeCompare(b.name))) {
          const src = s.source.padEnd(6);
          const desc = (s.description || '-').slice(0, 50);
          const warn = s.warnings.length ? ' ⚠️' : '';
          stderr.write(`  ${s.name.padEnd(maxName)}  ${src}  ${desc}${warn}\n`);
        }
        stderr.write(`\n${skills.length} skills. Commands: /skills show <name>\n`);
      }
      return true;
    }

    case 'agents': {
      const sub = args.split(/\s+/)[0]?.toLowerCase() || '';
      const subArg = args.split(/\s+/).slice(1).join(' ').trim();

      if (sub === 'validate') {
        const profiles = listProfiles();
        if (profiles.length === 0) {
          stderr.write('No profiles found in ~/.laia/agents/\n');
          return true;
        }
        let valid = 0, invalid = 0;
        for (const p of profiles) {
          try {
            loadProfile(p.name);
            stderr.write(`  ✅ ${p.name}\n`);
            valid++;
          } catch (e) {
            stderr.write(`  ❌ ${p.name}: ${e.message}\n`);
            invalid++;
          }
        }
        stderr.write(`\n${valid} valid, ${invalid} invalid\n`);
      } else if (sub === 'create') {
        if (!subArg) { stderr.write('Usage: /agents create <name>\n'); return true; }
        const safeName = subArg.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
        const { existsSync: exists, writeFileSync: writeFs, mkdirSync: mkDir } = await import('fs');
        const { join: joinPath } = await import('path');
        const { homedir: home } = await import('os');
        const dir = joinPath(home(), '.laia', 'agents');
        mkDir(dir, { recursive: true });
        const filePath = joinPath(dir, `${safeName}.yml`);
        if (exists(filePath)) {
          stderr.write(`\x1b[33mProfile '${safeName}' already exists: ${filePath}\x1b[0m\n`);
          return true;
        }
        const template = `# Agent profile: ${safeName}\nname: ${safeName}\ndescription: ""\nmodel: claude-opus-4.6\n# allowedTools: [read, glob, grep]\n# deniedTools: [agent]\nmaxSteps: 30\ntimeout: 60000\n# systemPrompt: |\n#   You are a specialized agent...\n`;
        writeFs(filePath, template);
        stderr.write(`\x1b[32m✅ Created: ${filePath}\x1b[0m\n`);
        stderr.write('Edit the file to customize model, tools, and prompt.\n');
      } else if (sub === 'show') {
        if (!subArg) { stderr.write('Usage: /agents show <name>\n'); return true; }
        try {
          const p = loadProfile(subArg);
          if (!p) { stderr.write(`Profile '${subArg}' not found\n`); return true; }
          stderr.write(`\n👤 ${p.name}\n`);
          for (const [key, val] of Object.entries(p)) {
            if (key === 'systemPrompt') { stderr.write(`  ${key}: (${val.length} chars)\n`); }
            else { stderr.write(`  ${key}: ${JSON.stringify(val)}\n`); }
          }
        } catch (e) {
          stderr.write(`\x1b[33mError: ${e.message}\x1b[0m\n`);
        }
      } else {
        const profiles = listProfiles();
        if (profiles.length === 0) {
          stderr.write('No profiles found. Create one at ~/.laia/agents/<name>.yml\n');
          return true;
        }
        stderr.write('\n👤 Agent Profiles (~/.laia/agents/)\n\n');
        const maxName = Math.max(6, ...profiles.map(p => p.name.length));
        stderr.write(`  ${'Name'.padEnd(maxName)}  Model              Description\n`);
        stderr.write(`  ${''.padEnd(maxName, '─')}  ${''.padEnd(18, '─')}  ${''.padEnd(30, '─')}\n`);
        for (const p of profiles) {
          const model = (p.model || '-').slice(0, 18).padEnd(18);
          const desc = (p.description || '-').slice(0, 50);
          stderr.write(`  ${p.name.padEnd(maxName)}  ${model}  ${desc}\n`);
        }
        stderr.write(`\n${profiles.length} profiles. Commands: /agents validate, /agents show <name>, /agents create <name>\n`);
      }
      return true;
    }

    case 'undo': {
      if (undoStack.depth === 0) {
        stderr.write('\x1b[33mNothing to undo\x1b[0m\n');
        return true;
      }

      const undoArgs = String(args ?? '').trim();
      const { relative: relPath } = await import('path');
      const rel = (f) => relPath(config.workspaceRoot, f).split('\\').join('/');

      // /undo --list — show all turns with diff stats
      if (undoArgs === '--list' || undoArgs === '-l' || undoArgs === 'list') {
        const turns = undoStack.list();
        stderr.write(`\x1b[1m↩️  Undo history (${turns.length} turn${turns.length !== 1 ? 's' : ''}, max ${undoStack.maxTurns})\x1b[0m\n\n`);
        for (const turn of turns) {
          const ago = Math.round((Date.now() - turn.timestamp) / 1000);
          const timeStr = ago < 60 ? `${ago}s ago` : ago < 3600 ? `${Math.round(ago / 60)}m ago` : `${Math.round(ago / 3600)}h ago`;
          const totalAdd = turn.files.reduce((s, f) => s + f.additions, 0);
          const totalDel = turn.files.reduce((s, f) => s + f.deletions, 0);
          stderr.write(`  \x1b[1m#${turn.index}\x1b[0m  \x1b[2m${timeStr}\x1b[0m  \x1b[32m+${totalAdd}\x1b[0m/\x1b[31m-${totalDel}\x1b[0m  (${turn.files.length} file${turn.files.length !== 1 ? 's' : ''})\n`);
          for (const file of turn.files) {
            const stats = file.additions || file.deletions ? ` \x1b[32m+${file.additions}\x1b[0m/\x1b[31m-${file.deletions}\x1b[0m` : '';
            stderr.write(`     ${file.path}${stats}\n`);
          }
        }
        stderr.write(`\n\x1b[2mUsage: /undo (last), /undo N (undo N turns), /undo --list\x1b[0m\n`);
        return true;
      }

      // /undo N — undo N turns from the top
      const num = parseInt(undoArgs, 10);
      if (!isNaN(num) && num > 0) {
        const target = Math.min(num, undoStack.depth);
        const result = undoStack.undoTo(target);
        if (!result) {
          stderr.write('\x1b[33mInvalid undo target.\x1b[0m\n');
          return true;
        }
        stderr.write(`\x1b[33m↩️  Undid ${result.turnsUndone} turn${result.turnsUndone !== 1 ? 's' : ''}\x1b[0m\n`);
        if (result.restored.length) {
          stderr.write(`\x1b[32m✓ Restored: ${result.restored.map(rel).join(', ')}\x1b[0m\n`);
        }
        if (result.deleted.length) {
          stderr.write(`\x1b[32m✓ Deleted (were new): ${result.deleted.map(rel).join(', ')}\x1b[0m\n`);
        }
        if (result.conflicts.length) {
          stderr.write(`\x1b[33m⚠️  Conflicts: ${result.conflicts.map(rel).join(', ')}\x1b[0m\n`);
        }
        stderr.write(`\x1b[2m[${undoStack.depth} more undo${undoStack.depth !== 1 ? 's' : ''} available]\x1b[0m\n`);
        return true;
      }

      // /undo — undo last turn (original behavior)
      const files = undoStack.peek();
      stderr.write(`\x1b[33m↩️  Undo last turn (${files.length} file${files.length > 1 ? 's' : ''}):\x1b[0m\n`);
      for (const f of files) {
        stderr.write(`  ${rel(f)}\n`);
      }
      const result = undoStack.undo();
      if (result.restored.length) {
        stderr.write(`\x1b[32m✓ Restored: ${result.restored.map(rel).join(', ')}\x1b[0m\n`);
      }
      if (result.deleted.length) {
        stderr.write(`\x1b[32m✓ Deleted (were new): ${result.deleted.map(rel).join(', ')}\x1b[0m\n`);
      }
      if (result.conflicts?.length) {
        stderr.write(`\x1b[33m⚠️  Conflicts (files modified after agent edit): ${result.conflicts.map(rel).join(', ')}\x1b[0m\n`);
      }
      stderr.write(`\x1b[2m[${undoStack.depth} more undo${undoStack.depth !== 1 ? 's' : ''} available]\x1b[0m\n`);
      return true;
    }

    case 'tokens': {
      const pct = context.usagePercent();
      const ctxEst = context.estimateTokens();
      const ctxMax = context.getMaxTokens();
      const turns = context.turnCount();
      const totalAll = sessionTokens.totalIn + sessionTokens.totalOut;
      const ctxColor = pct > 80 ? '31;1' : pct > 60 ? '33;1' : '32';
      stderr.write('\x1b[1m📊 Token Usage\x1b[0m\n');
      stderr.write('\n  \x1b[1mSession\x1b[0m\n');
      stderr.write(`    Turns:      ${sessionTokens.turns}\n`);
      stderr.write(`    Input:      ${formatTokenCount(sessionTokens.totalIn)}\n`);
      stderr.write(`    Output:     ${formatTokenCount(sessionTokens.totalOut)}\n`);
      stderr.write(`    Total:      \x1b[1m${formatTokenCount(totalAll)}\x1b[0m\n`);
      stderr.write('\n  \x1b[1mContext Window\x1b[0m\n');
      stderr.write(`    Estimated:  ${formatTokenCount(ctxEst)} / ${formatTokenCount(ctxMax)}\n`);
      stderr.write(`    Usage:      \x1b[${ctxColor}m${pct}%\x1b[0m\n`);
      stderr.write(`    Turns:      ${turns}\n`);
      if (attachManager.count() > 0) {
        stderr.write('\n  \x1b[1mAttachments\x1b[0m\n');
        stderr.write(`    Files:      ${attachManager.count()}\n`);
        stderr.write(`    Tokens:     ~${formatTokenCount(attachManager.estimateTokens())}\n`);
      }
      stderr.write('\n');
      return true;
    }

    case 'swarm': {
      config.swarm = !config.swarm;
      if (config.swarm) {
        const { registerAgentTool } = await import('../tools/agent.js');
        const { defaultRegistry } = await import('../tools/index.js');
        registerAgentTool(config, defaultRegistry);
      } else {
        const { defaultRegistry } = await import('../tools/index.js');
        defaultRegistry.delete('agent');
      }
      stderr.write(`🐝 Swarm ${config.swarm ? 'ON' : 'OFF'}\n`);
      return true;
    }

    case 'attached': {
      const files = attachManager.list();
      if (!files.length) {
        stderr.write('\x1b[2mNo files attached. Use /attach <path|glob>\x1b[0m\n');
        return true;
      }
      stderr.write('\x1b[1mAttached files:\x1b[0m\n');
      for (const f of files) {
        stderr.write(`  \x1b[36m${String(f.index).padStart(2)}\x1b[0m  ${f.name}  ${(f.size / 1024).toFixed(1)}KB  ~${f.tokens} tok  \x1b[2m${f.path}\x1b[0m\n`);
      }
      const total = attachManager.totalSize();
      const totalTok = attachManager.estimateTokens();
      stderr.write(`\x1b[2m  Total: ${(total / 1024).toFixed(1)}KB, ~${totalTok} tokens\x1b[0m\n`);
      return true;
    }

    case 'reflect': {
      const turns = context.turnCount();
      if (turns === 0) {
        stderr.write('\x1b[33mNothing to reflect on (no turns yet)\x1b[0m\n');
        return true;
      }

      stderr.write('\x1b[2m[reflect] Building transcript...\x1b[0m\n');

      // Build transcript from messages
      const messages = context.getMessages();
      const transcriptLines = [];
      for (const m of messages) {
        if (!m.content) continue;
        const role = m.role === 'user' ? 'USER' : m.role === 'assistant' ? 'ASSISTANT' : m.role.toUpperCase();
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        transcriptLines.push(`[${role}] ${content.slice(0, 2000)}`);
      }
      const transcript = transcriptLines.join('\n\n').slice(0, 24000);
      const autoSaveFlag = args === 'auto';

      stderr.write(`\x1b[2m[reflect] ${turns} turns, ${transcript.length} chars, auto_save=${autoSaveFlag}\x1b[0m\n`);

      try {
        const result = await brainReflectSession({
          transcript,
          auto_save: autoSaveFlag,
        });
        if (result) {
          stderr.write('\n\x1b[1m🔍 Reflection Results:\x1b[0m\n');
          stderr.write(result + '\n');
        } else {
          stderr.write('\x1b[33mNo reflection results (LLM may not be available)\x1b[0m\n');
        }
      } catch (err) {
        stderr.write(`\x1b[31mReflection failed: ${err.message}\x1b[0m\n`);
      }
      return true;
    }

    // --- Quick Win commands (Phase 1 roadmap) ---

    case 'commit': {
      stderr.write('\x1b[2m[commit] Gathering git data...\x1b[0m\n');
      try {
        const gitData = await gatherGitData();
        if (!gitData.diff && !gitData.status) {
          stderr.write('\x1b[33mNo changes detected. Nothing to commit.\x1b[0m\n');
          return true;
        }
        const prompt = buildCommitPrompt(gitData);
        const result = await executeTurn({
          input: prompt,
          config,
          logger,
          context,
          undoStack,
          autoCommitter,
          planMode: false,
          effort: effortCtrl.getEffort?.(),
        });
        return { handled: true, turnResult: result };
      } catch (err) {
        stderr.write(`\x1b[31mCommit failed: ${err.message}\x1b[0m\n`);
      }
      return true;
    }

    case 'review': {
      // Preflight: check gh CLI availability
      try {
        const { execSync } = await import('child_process');
        execSync('gh --version', { stdio: 'ignore', timeout: 5000 });
      } catch {
        stderr.write('\x1b[31m/review requires GitHub CLI (gh). Install: https://cli.github.com/\x1b[0m\n');
        return true;
      }
      const prompt = buildReviewPrompt(args);
      stderr.write(`\x1b[2m[review] ${args ? `Reviewing PR #${args}...` : 'Listing PRs...'}\x1b[0m\n`);
      try {
        const result = await executeTurn({
          input: prompt,
          config,
          logger,
          context,
          undoStack,
          autoCommitter,
          planMode: planCtrl.getPlanMode?.(),
          effort: effortCtrl.getEffort?.(),
        });
        return { handled: true, turnResult: result };
      } catch (err) {
        stderr.write(`\x1b[31mReview failed: ${err.message}\x1b[0m\n`);
      }
      return true;
    }

    case 'debug': {
      const prompt = buildDebugPrompt(args);
      stderr.write('\x1b[2m[debug] Analyzing session logs...\x1b[0m\n');
      try {
        const result = await executeTurn({
          input: prompt,
          config,
          logger,
          context,
          undoStack,
          autoCommitter,
          planMode: true,  // read-only — debug shouldn't write
          effort: effortCtrl.getEffort?.(),
        });
        return { handled: true, turnResult: result };
      } catch (err) {
        stderr.write(`\x1b[31mDebug failed: ${err.message}\x1b[0m\n`);
      }
      return true;
    }

    case 'style': {
      const DIM = '\x1b[2m';
      const R = '\x1b[0m';
      const B = '\x1b[1m';
      const G = '\x1b[32m';

      if (!args || args === 'list') {
        const styles = listOutputStyles(process.cwd());
        if (styles.length === 0) {
          stderr.write(`${DIM}No output styles found. Create .md files in ~/.laia/output-styles/${R}\n`);
        } else {
          stderr.write(`\n${B}Output Styles:${R}\n`);
          const current = process.env.LAIA_OUTPUT_STYLE || config.outputStyle || '(none)';
          for (const s of styles) {
            const active = s.name === current ? ` ${G}← active${R}` : '';
            stderr.write(`  ${B}${s.name}${R} — ${DIM}${s.description}${R}${active}\n`);
          }
          stderr.write(`\nUse: /style <name> to activate, /style off to disable\n\n`);
        }
      } else if (args === 'off') {
        delete process.env.LAIA_OUTPUT_STYLE;
        config.outputStyle = null;
        stderr.write(`${G}Output style disabled.${R}\n`);
      } else {
        const styles = listOutputStyles(process.cwd());
        const style = styles.find(s => s.name === args);
        if (style) {
          config.outputStyle = args;
          process.env.LAIA_OUTPUT_STYLE = args;
          stderr.write(`${G}Output style set to: ${B}${args}${R}\n`);
        } else {
          stderr.write(`\x1b[33mStyle '${args}' not found. Use /style list to see available styles.\x1b[0m\n`);
        }
      }
      return true;
    }

    case 'tip': {
      const tip = getRandomTip();
      if (tip) {
        stderr.write(`\n${tip.content}\n\n`);
      } else {
        stderr.write('\x1b[2mNo tips available.\x1b[0m\n');
      }
      return true;
    }

    case 'reflect': {
      const DIM = '\x1b[2m';
      const R = '\x1b[0m';
      if (session.context.turnCount() < 3) {
        stderr.write(`\x1b[33mNeed at least 3 turns for reflection.${R}\n`);
        return true;
      }
      stderr.write(`${DIM}Running reflection pipeline...${R}\n`);
      return { reflectRequested: true };
    }

    case 'evolve': {
      const DIM = '\x1b[2m';
      const R = '\x1b[0m';
      const B = '\x1b[1m';
      const G = '\x1b[32m';
      const Y = '\x1b[33m';
      const C = '\x1b[36m';

      const sub = args?.trim()?.split(/\s+/);
      const subCmd = sub?.[0] || 'list';
      const subArg = sub?.slice(1).join(' ');

      switch (subCmd) {
        case 'list': {
          const { stableEntries, adaptiveEntries, version } = loadEvolvedIndex();
          stderr.write(`\n${B}📋 Evolved Prompt Entries${R}\n`);
          if (version) {
            stderr.write(`${DIM}Version: ${version.version} | Compiled: ${version.compiled_at}${R}\n`);
          }
          stderr.write(`\n${G}Stable (${stableEntries.size}):${R}\n`);
          if (stableEntries.size === 0) {
            stderr.write(`${DIM}  (none)${R}\n`);
          } else {
            for (const [slug, meta] of stableEntries) {
              stderr.write(`  📌 ${slug}${DIM}  promoted: ${meta.promoted_at || '?'}${meta.manual ? ' (manual)' : ''}${R}\n`);
            }
          }
          stderr.write(`\n${C}Adaptive (${adaptiveEntries.size}):${R}\n`);
          if (adaptiveEntries.size === 0) {
            stderr.write(`${DIM}  (none)${R}\n`);
          } else {
            for (const [slug, meta] of adaptiveEntries) {
              const expired = meta.expired ? ` ${Y}[EXPIRED]${R}` : '';
              stderr.write(`  🔄 ${slug}${DIM}  added: ${meta.added_at || '?'}${R}${expired}\n`);
            }
          }
          stderr.write('\n');
          return true;
        }

        case 'budget': {
          const stats = getPromptStats();
          if (!stats) {
            stderr.write(`${Y}No prompt stats yet (run a turn first).${R}\n`);
            return true;
          }
          stderr.write('\n' + formatBudgetStats(stats) + '\n\n');
          return true;
        }

        case 'promote': {
          if (!subArg) {
            stderr.write(`${Y}Usage: /evolve promote <slug>${R}\n`);
            return true;
          }
          const ok = promoteEntry(subArg);
          stderr.write(ok
            ? `${G}✅ Promoted "${subArg}" to stable.${R}\n`
            : `${Y}⚠ "${subArg}" not found or already stable.${R}\n`);
          return true;
        }

        case 'demote': {
          if (!subArg) {
            stderr.write(`${Y}Usage: /evolve demote <slug>${R}\n`);
            return true;
          }
          const ok = demoteEntry(subArg);
          stderr.write(ok
            ? `${G}✅ Demoted "${subArg}" to adaptive.${R}\n`
            : `${Y}⚠ "${subArg}" not found or not stable.${R}\n`);
          return true;
        }

        case 'expire': {
          if (!subArg) {
            stderr.write(`${Y}Usage: /evolve expire <slug>${R}\n`);
            return true;
          }
          const ok = expireEntry(subArg);
          stderr.write(ok
            ? `${G}✅ Expired "${subArg}".${R}\n`
            : `${Y}⚠ "${subArg}" not found in adaptive entries.${R}\n`);
          return true;
        }

        case 'conflicts': {
          const { stable, adaptive } = loadEvolvedSplit();
          if (!stable || !adaptive) {
            stderr.write(`${DIM}No evolved content or only one layer present.${R}\n`);
            return true;
          }
          const conflicts = detectConflicts(stable, adaptive);
          if (conflicts.length === 0) {
            stderr.write(`${G}✅ No conflicts detected between stable and adaptive.${R}\n`);
          } else {
            stderr.write(`\n${Y}⚠ ${conflicts.length} potential conflict(s):${R}\n\n`);
            for (const c of conflicts) {
              stderr.write(`  ${B}[${c.confidence}]${R} ${c.type}\n`);
              stderr.write(`  ${G}Stable:${R}   ${c.stable}\n`);
              stderr.write(`  ${Y}Adaptive:${R} ${c.adaptive}\n\n`);
            }
          }
          return true;
        }

        case 'recompile': {
          stderr.write(`${DIM}Recompiling evolved prompt from brain...${R}\n`);
          try {
            const { brainSearch } = await import('../brain/client.js');
            const result = await compileEvolvedPrompt(brainSearch);
            stderr.write(`${G}✅ Compiled v${result.version}: ${result.stableCount} stable, ${result.adaptiveCount} adaptive, +${result.added} -${result.removed} ⏰${result.expired} ⬆${result.promoted}${R}\n`);
          } catch (err) {
            stderr.write(`${Y}⚠ Compile failed: ${err.message}${R}\n`);
          }
          return true;
        }

        default:
          stderr.write(`${Y}Unknown subcommand: ${subCmd}. Try: list, budget, promote, demote, expire, conflicts, recompile${R}\n`);
          return true;
      }
    }

    case 'tasks': {
      const DIM = '\x1b[2m';
      const R = '\x1b[0m';
      const B = '\x1b[1m';
      const C = '\x1b[36m';
      const G = '\x1b[32m';
      const RED = '\x1b[31m';
      const Y = '\x1b[33m';

      const sub = args?.trim();

      if (sub?.startsWith('get ')) {
        // /tasks get <taskId>
        const taskId = sub.slice(4).trim();
        const result = getBackgroundResult(taskId);
        if (result.error) {
          stderr.write(`${RED}${result.error}${R}\n`);
        } else if (result.status === 'running') {
          stderr.write(`${Y}Task ${taskId} still running: ${result.description}${R}\n`);
        } else {
          stderr.write(`\n${B}Result of ${taskId}:${R}\n`);
          const raw = result.text || result.error || '';
          const text = (typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2))
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''); // Strip control chars
          stderr.write(`${text.slice(0, 2000)}\n\n`);
        }
      } else {
        // /tasks — list all
        const tasks = listBackgroundAgents();
        if (tasks.length === 0) {
          stderr.write(`${DIM}No background agents. Use agent({ run_in_background: true }) to start one.${R}\n`);
        } else {
          stderr.write(`\n${B}Background Agents (${tasks.length}):${R}\n\n`);
          for (const t of tasks) {
            const dur = (t.durationMs / 1000).toFixed(1);
            const icon = t.status === 'completed' ? `${G}✅` : t.status === 'failed' ? `${RED}❌` : `${Y}⏳`;
            stderr.write(`  ${icon} ${B}${t.taskId}${R} ${DIM}${t.description}${R} [${t.status}] ${DIM}${dur}s${R}\n`);
          }
          stderr.write(`\n${DIM}Use /tasks get <taskId> to see result.${R}\n\n`);
        }
      }
      return true;
    }

    case 'coordinator': {
      const DIM = '\x1b[2m';
      const R = '\x1b[0m';
      const B = '\x1b[1m';
      const C = '\x1b[36m';
      const G = '\x1b[32m';

      // Lazily create coordinator if not present
      if (!session.coordinator) {
        session.coordinator = createCoordinator();
      }
      const coord = session.coordinator;

      const sub = args?.trim()?.toLowerCase();

      if (!sub || sub === 'on') {
        if (coord.isActive()) {
          stderr.write(`${C}Coordinator mode already active (phase: ${coord.getPhase()})${R}\n`);
        } else {
          coord.activate();
          stderr.write(`${G}\n🤖 Coordinator Mode ON${R}\n`);
          stderr.write(`${DIM}The LLM will now orchestrate workers in 4 phases:\n`);
          stderr.write(`  1. Research (parallel workers investigate)\n`);
          stderr.write(`  2. Synthesis (coordinator formulates specs)\n`);
          stderr.write(`  3. Implementation (workers with precise specs)\n`);
          stderr.write(`  4. Verification (fresh workers verify)\n`);
          stderr.write(`\nUse /coordinator off to deactivate, /coordinator status for info.${R}\n\n`);
        }
      } else if (sub === 'off') {
        coord.deactivate();
      } else if (sub === 'status') {
        const status = coord.getStatus();
        if (!status.active) {
          stderr.write(`${DIM}Coordinator mode is OFF. Use /coordinator on to activate.${R}\n`);
        } else {
          stderr.write(`\n${B}Coordinator Status:${R}\n`);
          stderr.write(`  ${C}Phase:${R} ${status.phase}\n`);
          stderr.write(`  ${C}Workers:${R} ${status.workers.total} total (${status.workers.running} running, ${status.workers.completed} completed, ${status.workers.failed} failed)\n`);
          if (status.phaseHistory.length > 0) {
            stderr.write(`  ${C}History:${R} ${status.phaseHistory.map(h => h.phase).join(' → ')} → ${status.phase}\n`);
          }
          stderr.write('\n');
        }
      } else {
        stderr.write(`\x1b[33mUsage: /coordinator [on|off|status]${R}\n`);
      }
      return true;
    }

    case 'memory': {
      const DIM = '\x1b[2m';
      const R = '\x1b[0m';
      const B = '\x1b[1m';
      const C = '\x1b[36m';
      const G = '\x1b[32m';

      const sub = args?.split(' ')[0]?.toLowerCase();

      if (!sub || sub === 'list') {
        const all = loadAllMemories();
        const stats = getMemoryStats();
        if (all.length === 0) {
          stderr.write(`${DIM}No typed memories yet. Use /memory add <type> <name> <description>${R}\n`);
          stderr.write(`${DIM}Types: ${MEMORY_TYPES.join(', ')}. See /memory types for details.${R}\n`);
        } else {
          stderr.write(`\n${B}Typed Memories (${stats.typed} active, ${stats.promoted} promoted to brain):${R}\n\n`);
          for (const type of MEMORY_TYPES) {
            const mems = all.filter(m => m.type === type);
            if (mems.length === 0) continue;
            const owner = getOwner(type) || 'unknown';
            stderr.write(`${C}  ${type} (${mems.length}) ${DIM}[owner: ${owner}]${R}\n`);
            for (const m of mems) {
              const stale = m.staleWarning ? ` ${DIM}${m.staleWarning}${R}` : '';
              const promoted = m.promotion_state === 'promoted' ? ` ${DIM}[→brain]${R}` : '';
              stderr.write(`    ${B}${m.name}${R}: ${DIM}${m.description.split('\n')[0].slice(0, 80)}${R}${stale}${promoted}\n`);
            }
          }
          stderr.write('\n');
        }
      } else if (sub === 'types') {
        stderr.write(`\n${B}Memory Types:${R}\n\n`);
        const { MEMORY_TYPE_DESCRIPTIONS } = await import('../memory/typed-memory.js');
        for (const type of MEMORY_TYPES) {
          const desc = MEMORY_TYPE_DESCRIPTIONS[type];
          stderr.write(`${C}${type}${R}: ${desc.description}\n`);
          stderr.write(`  ${DIM}Save when: ${desc.when_to_save}${R}\n`);
          stderr.write(`  ${DIM}Example: ${desc.examples[0]}${R}\n\n`);
        }
      } else if (sub === 'add') {
        // /memory add <type> <name> <...description>
        const parts = args.slice(4).trim().split(' ');
        const type = parts[0];
        const name = parts[1];
        const description = parts.slice(2).join(' ');

        if (!type || !name || !description) {
          stderr.write(`\x1b[33mUsage: /memory add <type> <name> <description>${R}\n`);
          stderr.write(`${DIM}Types: ${MEMORY_TYPES.join(', ')}${R}\n`);
          return true;
        }

        if (!MEMORY_TYPES.includes(type)) {
          // Check if it's a brain-owned type
          if (OWNERSHIP_MATRIX[type]?.owner === 'brain') {
            stderr.write(`\x1b[33mType '${type}' is owned by Brain. Use brain_remember instead.${R}\n`);
            stderr.write(`${DIM}Brain types: procedure, learning, warning, pattern, principle${R}\n`);
            return true;
          }
          stderr.write(`\x1b[31mInvalid type '${type}'. Valid typed: ${MEMORY_TYPES.join(', ')}${R}\n`);
          stderr.write(`${DIM}Brain-owned types (use brain_remember): procedure, learning, warning, pattern, principle${R}\n`);
          return true;
        }

        try {
          const result = saveMemory({ type, name, description });
          stderr.write(`${G}\u2705 Memory saved: ${type}/${result.slug}${R}\n`);
        } catch (err) {
          stderr.write(`\x1b[31mFailed: ${err.message}${R}\n`);
        }
      } else {
        // /memory <type> — list memories of that type
        if (MEMORY_TYPES.includes(sub)) {
          const mems = loadMemories(sub);
          if (mems.length === 0) {
            stderr.write(`${DIM}No ${sub} memories yet.${R}\n`);
          } else {
            stderr.write(`\n${C}${sub} memories (${mems.length}):${R}\n`);
            for (const m of mems) {
              const stale = m.staleWarning ? ` ${DIM}${m.staleWarning}${R}` : '';
              stderr.write(`  ${B}${m.name}${R}: ${m.description.split('\n')[0].slice(0, 100)}${stale}\n`);
            }
            stderr.write('\n');
          }
        } else {
          stderr.write(`\x1b[33mUnknown subcommand '${sub}'. Try: /memory list, /memory add, /memory types, /memory <type>${R}\n`);
        }
      }
      return true;
    }

    case 'skillify': {
      const { buildSkillifyPrompt, extractUserMessages, getSkillifyBanner } = await import('../skills/skillify.js');
      const { getRecentMessages } = await import('../skills/improvement.js');

      // Gather user messages from session context + improvement ring buffer
      let userMsgs = extractUserMessages(context);
      if (userMsgs.length === 0) {
        // Fallback: use the improvement module's recent messages ring buffer
        userMsgs = getRecentMessages();
      }

      // Show banner
      stderr.write(getSkillifyBanner(userMsgs.length));

      // Build dynamic prompt with session context injected
      const description = args || '';
      const skillifyPrompt = buildSkillifyPrompt({ userMessages: userMsgs, description });

      try {
        const result = await executeTurn({
          input: skillifyPrompt,
          config,
          logger,
          context,
          undoStack,
          autoCommitter,
          planMode: planCtrl.getPlanMode?.(),
          effort: effortCtrl.getEffort?.(),
        });
        return { handled: true, turnResult: result };
      } catch (err) {
        stderr.write(`\x1b[31mError in /skillify: ${err.message}\x1b[0m\n`);
      }
      return true;
    }

    case 'status': {
      const { detectProvider: dp, isProviderAvailable: isAvail, PROVIDERS: provs } = await import('@laia/providers');
      const { getDefaultConnection } = await import('../brain/client.js');
      const { listSkills: ls } = await import('../skills.js');

      stderr.write('\n\x1b[1m📊 LAIA System Status\x1b[0m\n\n');

      // Providers
      stderr.write('\x1b[1m  Providers:\x1b[0m\n');
      const { providerId: current } = dp(config.model, { forceProvider: config.provider });
      for (const pid of Object.keys(provs)) {
        if (pid === 'genai') continue; // internal
        const avail = isAvail(pid);
        const icon = avail ? '\x1b[32m✅\x1b[0m' : '\x1b[2m⬚\x1b[0m';
        const active = pid === current ? ' \x1b[33m← active\x1b[0m' : '';
        stderr.write(`    ${icon} ${pid}${active}\n`);
      }

      // Brain
      stderr.write('\n\x1b[1m  Brain:\x1b[0m\n');
      const brain = getDefaultConnection();
      if (brain) {
        stderr.write(`    \x1b[32m✅\x1b[0m Connected (path: ${config.brainPath})\n`);
      } else {
        stderr.write(`    \x1b[31m❌\x1b[0m Not connected\n`);
      }

      // Skills
      const skills = ls({ force: true });
      stderr.write(`\n\x1b[1m  Skills:\x1b[0m ${skills.length} loaded\n`);

      // Model & Session
      stderr.write(`\n\x1b[1m  Session:\x1b[0m\n`);
      stderr.write(`    Model:    ${config.model}\n`);
      stderr.write(`    Provider: ${current}\n`);
      stderr.write(`    Turns:    ${context.turnCount()}\n`);
      stderr.write(`    CWD:      ${config.workspaceRoot}\n`);
      stderr.write('\n');
      return true;
    }

    case 'doctor': {
      const { runDoctor } = await import('../services/doctor.js');
      const { getHookStats } = await import('../hooks/bus.js');
      const { loadFlags } = await import('../config/flags.js');
      const { listSkills } = await import('../skills.js');
      const skills = listSkills({ force: true });
      await runDoctor({
        config,
        hookStats: getHookStats(),
        flags: loadFlags(),
        skillCount: skills.length,
      });
      return true;
    }

    case 'sleep': {
      const { runSleepCycle, pruneDailyMemories } = await import('../services/sleep-cycle.js');
      const date = args || undefined;
      const force = args.includes('--force');
      const dateArg = args.replace('--force', '').trim() || undefined;
      stderr.write('\x1b[36m🌙 Running sleep cycle...\x1b[0m\n');
      const result = runSleepCycle({ date: dateArg, force });
      if (result) {
        stderr.write(`\x1b[32m✓ Daily memory: ${result.bullets} bullets from ${result.sessions} sessions (${result.bytes}B)\x1b[0m\n`);
      } else {
        stderr.write('\x1b[33m⚠ No new daily memory generated (no sessions or already exists)\x1b[0m\n');
      }
      const pruned = pruneDailyMemories();
      if (pruned > 0) stderr.write(`\x1b[2m✂ Pruned ${pruned} old daily memories\x1b[0m\n`);
      return true;
    }

    case 'init': {
      const { runInit } = await import('../services/init-project.js');
      const dryRun = args.includes('--dry-run');
      const force = args.includes('--force');
      // Remove flags from args
      const target = args.includes('--project') ? 'project' : 'dotlaia';
      await runInit({ workspaceRoot: config.workspaceRoot, dryRun, target, force });
      return true;
    }

    case 'flags': {
      const DIM = '\x1b[2m';
      const R = '\x1b[0m';
      const B = '\x1b[1m';
      const G = '\x1b[32m';
      const Y = '\x1b[33m';

      const { getFlagsWithSource, setFlag } = await import('../config/flags.js');

      if (args.startsWith('set ')) {
        // /flags set <key> <value>
        const parts = args.slice(4).trim().split(/\s+/);
        const key = parts[0];
        let value = parts.slice(1).join(' ');
        if (!key || !value) {
          stderr.write(`${Y}Usage: /flags set <key> <value>${R}\n`);
          return true;
        }
        // Parse value
        if (value === 'true') value = true;
        else if (value === 'false') value = false;
        else if (!isNaN(Number(value))) value = Number(value);
        try {
          setFlag(key, value);
          stderr.write(`${G}✅ Flag ${key} = ${JSON.stringify(value)} (saved to disk)${R}\n`);
        } catch (err) {
          stderr.write(`${Y}${err.message}${R}\n`);
        }
      } else {
        // /flags — list all
        const flagsInfo = getFlagsWithSource();
        stderr.write(`\n${B}🚩 Feature Flags${R}\n\n`);
        const maxKey = Math.max(6, ...flagsInfo.map(f => f.key.length));
        for (const f of flagsInfo) {
          const srcColor = f.source === 'env' ? Y : f.source === 'file' ? G : DIM;
          const val = JSON.stringify(f.value);
          stderr.write(`  ${B}${f.key.padEnd(maxKey)}${R}  ${val.padEnd(8)}  ${srcColor}[${f.source}]${R}\n`);
        }
        stderr.write(`\n${DIM}Use: /flags set <key> <value>  |  Env: LAIA_FLAG_<KEY>=value${R}\n\n`);
      }
      return true;
    }

    // ─── Nextcloud Sprint 2 Commands ────────────────────────────────────────

    case 'talk': {
      const DIM = '\x1b[2m';
      const R = '\x1b[0m';
      const B = '\x1b[1m';
      const GREEN = '\x1b[32m';
      const sub = args.split(/\s+/)[0] || 'poll';
      const rest = args.slice(sub.length).trim();

      if (sub === 'rooms') {
        const { listConversations } = await import('../channels/talk-client.js');
        try {
          const rooms = await listConversations();
          stderr.write(`\n${B}☁️ Talk Conversations${R}\n\n`);
          const typeNames = { 1: 'DM', 2: 'Group', 3: 'Public', 4: 'Changelog', 5: 'Former', 6: 'NoteToSelf' };
          for (const r of rooms) {
            const type = typeNames[r.type] || `type:${r.type}`;
            stderr.write(`  ${r.token}  ${B}${r.displayName}${R}  ${DIM}(${type})${R}\n`);
          }
          stderr.write(`\n${DIM}Total: ${rooms.length} conversations${R}\n\n`);
        } catch (err) {
          stderr.write(`\x1b[31mError: ${err.message}\x1b[0m\n`);
          stderr.write(`${DIM}Ensure NC_URL, NC_USER, NC_PASS are configured in ~/.laia/.env${R}\n`);
        }
        return true;
      }

      if (sub === 'poll') {
        const { pollOnce } = await import('../channels/talk-poller.js');
        stderr.write(`\n${DIM}☁️ Polling Talk for new messages...${R}\n`);
        try {
          const tasks = await pollOnce();
          if (tasks.length === 0) {
            stderr.write(`${GREEN}✓ No new messages${R}\n\n`);
          } else {
            stderr.write(`\n${B}📨 ${tasks.length} new message(s):${R}\n\n`);
            for (const t of tasks) {
              stderr.write(`  ${B}${t.author}${R} ${DIM}(${t.roomName})${R}: ${t.text.slice(0, 120)}\n`);
            }
            stderr.write('\n');
          }
        } catch (err) {
          stderr.write(`\x1b[31mError: ${err.message}\x1b[0m\n`);
        }
        return true;
      }

      if (sub === 'send') {
        if (!rest) {
          stderr.write('Usage: /talk send <token> <message>\n');
          return true;
        }
        const [token, ...msgParts] = rest.split(/\s+/);
        const msg = msgParts.join(' ');
        if (!token || !msg) {
          stderr.write('Usage: /talk send <token> <message>\n');
          return true;
        }
        const { sendMessage } = await import('../channels/talk-client.js');
        try {
          await sendMessage(token, msg);
          stderr.write(`${GREEN}✓ Message sent to ${token}${R}\n`);
        } catch (err) {
          stderr.write(`\x1b[31mError: ${err.message}\x1b[0m\n`);
        }
        return true;
      }

      stderr.write('Usage: /talk [poll|send|rooms]\n');
      return true;
    }

    case 'cron': {
      const DIM = '\x1b[2m';
      const R = '\x1b[0m';
      const B = '\x1b[1m';
      const { loadCronFile } = await import('../channels/cron-file.js');
      const { join: joinP } = await import('path');
      const { homedir: home } = await import('os');
      const cronPath = joinP(home(), '.laia', 'CRON.md');
      const { jobs, errors } = loadCronFile(cronPath);

      stderr.write(`\n${B}⏰ Scheduled Jobs${R} ${DIM}(${cronPath})${R}\n\n`);

      if (jobs.length === 0 && errors.length === 0) {
        stderr.write(`  ${DIM}No jobs found. Create ~/.laia/CRON.md with \`\`\`toml blocks.${R}\n\n`);
        return true;
      }

      for (const job of jobs) {
        const status = job.enabled ? '\x1b[32m●\x1b[0m' : '\x1b[2m○\x1b[0m';
        const type = job.prompt ? 'prompt' : 'command';
        stderr.write(`  ${status} ${B}${job.name}${R}  ${DIM}${job.cron}${R}  [${type}]\n`);
        const detail = (job.prompt || job.command || '').slice(0, 80);
        stderr.write(`    ${DIM}${detail}${R}\n`);
      }

      if (errors.length > 0) {
        stderr.write(`\n\x1b[33m⚠ ${errors.length} error(s):\x1b[0m\n`);
        for (const e of errors) stderr.write(`  - ${e}\n`);
      }
      stderr.write('\n');
      return true;
    }

    case 'confirm': {
      const DIM = '\x1b[2m';
      const R = '\x1b[0m';
      const B = '\x1b[1m';
      const { getPendingConfirmations, resolveConfirmation } = await import('../services/confirmation.js');
      const sub = args.split(/\s+/)[0] || 'list';
      const rest = args.slice(sub.length).trim();

      if (sub === 'list' || sub === '') {
        const pending = getPendingConfirmations();
        if (pending.length === 0) {
          stderr.write(`\n${DIM}No pending confirmations${R}\n\n`);
        } else {
          stderr.write(`\n${B}⏳ Pending Confirmations (${pending.length})${R}\n\n`);
          for (const c of pending) {
            const age = Math.round((Date.now() - new Date(c.createdAt).getTime()) / 1000);
            stderr.write(`  ${B}${c.id}${R}  ${c.toolName}  risk:${c.risk}  ${DIM}${age}s ago${R}\n`);
          }
          stderr.write(`\n${DIM}Use: /confirm approve <id> | /confirm deny <id>${R}\n\n`);
        }
        return true;
      }

      if (sub === 'approve' || sub === 'deny') {
        const id = rest;
        if (!id) {
          stderr.write(`Usage: /confirm ${sub} <id>\n`);
          return true;
        }
        const approved = sub === 'approve';
        const found = resolveConfirmation(id, approved);
        if (found) {
          stderr.write(`${approved ? '\x1b[32m✓ Approved' : '\x1b[31m✗ Denied'}: ${id}${R}\n`);
        } else {
          stderr.write(`\x1b[33m⚠ Confirmation '${id}' not found or already resolved${R}\n`);
        }
        return true;
      }

      stderr.write('Usage: /confirm [list|approve|deny] [id]\n');
      return true;
    }

    case 'nc-tasks': {
      const DIM = '\x1b[2m';
      const R = '\x1b[0m';
      const B = '\x1b[1m';
      const { loadTasksFile, getPendingTasks } = await import('../channels/cron-file.js');
      const { join: joinP } = await import('path');
      const { homedir: home } = await import('os');
      const sub = args.split(/\s+/)[0] || 'list';
      const tasksPath = joinP(home(), '.laia', 'TASKS.md');
      const { tasks, errors } = loadTasksFile(tasksPath);

      if (tasks.length === 0) {
        stderr.write(`\n${DIM}No tasks found. Create ~/.laia/TASKS.md with checkbox items.${R}\n\n`);
        return true;
      }

      const pending = getPendingTasks(tasks);
      const done = tasks.filter(t => t.done);

      stderr.write(`\n${B}📋 Tasks${R} ${DIM}(${tasksPath})${R}\n\n`);

      if (sub === 'pending') {
        for (const t of pending) {
          const p = t.priority === 'urgent' ? '\x1b[31m!!' : t.priority === 'high' ? '\x1b[33m!' : DIM + '·';
          stderr.write(`  ${p}${R} ${t.text}\n`);
        }
      } else {
        for (const t of tasks) {
          const check = t.done ? '\x1b[32m✓\x1b[0m' : '\x1b[2m○\x1b[0m';
          const p = t.priority === 'urgent' ? ' \x1b[31m!!\x1b[0m' : t.priority === 'high' ? ' \x1b[33m!\x1b[0m' : '';
          const dim = t.done ? DIM : '';
          stderr.write(`  ${check} ${dim}${t.text}${R}${p}\n`);
        }
      }

      stderr.write(`\n${DIM}${pending.length} pending, ${done.length} done${R}\n`);

      if (errors.length > 0) {
        stderr.write(`\n\x1b[33m⚠ ${errors.length} parse error(s):\x1b[0m\n`);
        for (const e of errors) stderr.write(`  - ${e}\n`);
      }
      stderr.write('\n');
      return true;
    }

    default: {
      const cmd = fileCommands.get(name);
      if (cmd) {
        const expanded = expandCommand(cmd, args);
        stderr.write(`\x1b[2m[/${name}] Expanding command...\x1b[0m\n`);
        try {
          const result = await executeTurn({
            input: expanded,
            config,
            logger,
            context,
            undoStack,
            autoCommitter,
            planMode: planCtrl.getPlanMode?.(),
            effort: effortCtrl.getEffort?.(),
          });
          // Return result so main loop can do post-turn accounting
          return { handled: true, turnResult: result };
        } catch (err) {
          stderr.write(`\x1b[31mError: ${err.message}\x1b[0m\n`);
        }
        return true;
      }
      stderr.write(`Unknown command: /${name}. Try /help\n`);
      return true;
    }
  }
}

export async function handleModelCommand(args, config) {
  if (!args) {
    // List models from ALL available providers
    const { providerId: currentProvider } = detectProvider(config.model, { forceProvider: config.provider });
    const providerIds = Object.keys(PROVIDERS);
    let anyListed = false;

    for (const pid of providerIds) {
      const provider = getProvider(pid);
      if (!provider.supports?.listModels) continue;
      if (!isProviderAvailable(pid)) continue;
      // OpenRouter hidden from /model list — too slow and unreliable vs Groq/Cerebras
      if (pid === 'openrouter') continue;

      try {
        const token = await getProviderToken(pid);
        const url = resolveUrl(provider, 'models');
        const authHeaders = buildAuthHeaders(provider, token);

        const res = await fetch(url, {
          headers: { 'Content-Type': 'application/json', ...authHeaders, ...provider.extraHeaders },
        });
        if (!res.ok) continue;
        const data = await res.json();
        const models = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
        if (!models.length) continue;

        const marker = pid === currentProvider ? ' \x1b[32m◀ active\x1b[0m' : '';
        console.log(`\n\x1b[1m${pid}\x1b[0m${marker}`);
        for (const m of models) {
          if (m.policy && m.policy.state !== 'enabled') continue;
          const id = m.id?.replace?.(/^models\//, '') ?? m.id;
          // Google free tier: skip models with no free quota (pro, 2.0, embedding, etc.)
          if (pid === 'google') {
            const freeModels = /^gemini-(2\.5-flash|3-flash|3\.1-flash)/;
            if (!freeModels.test(id)) continue;
          }
          // OpenRouter: only show :free models with tool support
          if (pid === 'openrouter') {
            if (!id.endsWith(':free')) continue;
            const sp = m.supported_parameters || [];
            if (!sp.includes('tools') && !sp.includes('tool_choice')) continue;
          }
          const current = config.model === id ? ' \x1b[32m← current\x1b[0m' : '';
          const ctx = m.capabilities?.limits?.max_context_window_tokens || m.context_window;
          const out = m.capabilities?.limits?.max_output_tokens;
          const info = ctx || out
            ? `  \x1b[2m(${ctx ? Math.round(ctx/1000)+'K ctx' : '?'}${out ? ', '+(out/1000)+'K out' : ''})\x1b[0m`
            : (m.display_name ? `  \x1b[2m${m.display_name}\x1b[0m` : '');
          // Show prefix hint for non-auto-detected providers
          const prefix = pid === currentProvider ? '' : `\x1b[2m${pid}:\x1b[0m`;
          console.log(`  ${prefix}${id}${info}${current}`);
        }
        anyListed = true;
      } catch {
        // skip provider if it fails
      }
    }

    if (!anyListed) {
      console.log('No providers available. Configure API keys in ~/.laia/.env');
    }
    console.log('\nUse: /model <id>  or  /model <provider>:<id>\n');
    return;
  }

  const target = args.trim();
  config.model = target;
  if (target === 'auto') {
    console.log('Model: auto-routing enabled (codex · claude-opus-4.6 · gpt-5-mini per turn)');
  } else {
    console.log(`Model switched to: ${config.model}`);
  }
}
