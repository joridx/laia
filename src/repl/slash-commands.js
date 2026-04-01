// src/repl/slash-commands.js
// Slash command dispatch — extracted from repl.js
// Each command handler returns true (handled) or false.

import { stderr } from 'process';
import { detectProvider, getProvider, resolveUrl, buildAuthHeaders } from '@laia/providers';
import { getProviderToken } from '../auth.js';
import { expandCommand, listSkills, loadSkill } from '../skills.js';
import { stopBrain, brainReflectSession } from '../brain/client.js';
import { getRandomTip, buildCommitPrompt, gatherGitData, buildReviewPrompt, buildDebugPrompt, listOutputStyles } from '../quick-wins/index.js';
import { buildCompactionRequest, formatCompactSummary, applyCompaction } from '../phase2/compaction.js';
import { MEMORY_TYPES, saveMemory, loadMemories, loadAllMemories } from '../phase2/typed-memory.js';
import { createCoordinator } from '../phase4/coordinator.js';
import { normalizeEffort } from '../config.js';
import { saveSession, autoSave, loadSession, listSessions, forkSession as forkSessionFn } from '../session.js';
import { loadProfile, listProfiles } from '../profiles.js';
import { executeTurn } from './turn-runner.js';

// --- Command metadata for autocomplete + help ---
export const COMMAND_META = {
  '/save':       { desc: 'Save session',                  cat: 'session',  subs: [] },
  '/load':       { desc: 'Restore session',                cat: 'session',  subs: ['autosave'] },
  '/sessions':   { desc: 'List saved sessions',            cat: 'session',  subs: [] },
  '/fork':       { desc: 'Fork current session',           cat: 'session',  subs: [] },
  '/clear':      { desc: 'Clear history',                  cat: 'session',  subs: [] },
  '/compact':    { desc: 'Compact history',                cat: 'session',  subs: [] },
  '/model':      { desc: 'Change model',                   cat: 'config',   subs: ['auto'] },
  '/effort':     { desc: 'Set reasoning effort',           cat: 'config',   subs: ['low', 'medium', 'high', 'max'] },
  '/plan':       { desc: 'Read-only mode (no writes)',     cat: 'config',   subs: [] },
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
  '/memory':     { desc: 'Typed memories (user/feedback/project/ref)',  cat: 'system', subs: ['list', 'add', 'types'] },
  '/coordinator': { desc: 'Toggle coordinator mode (4-phase)',  cat: 'agents',   subs: ['on', 'off', 'status'] },
  '/autocommit': { desc: 'Toggle git auto-commit',         cat: 'system',   subs: [] },
  '/undo':       { desc: 'Revert last turn changes',       cat: 'system',   subs: [] },
  '/reflect':    { desc: 'Reflect on session (brain LLM)',  cat: 'system',   subs: ['auto'] },
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
  const { config, logger, context, fileCommands, attachManager, autoCommitter, undoStack, planCtrl, effortCtrl, sessionTokens } = session;

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
      if (context.turnCount() > 0) {
        try {
          autoSave(context.serialize(), { sessionId: '', model: config.model, workspaceRoot: config.workspaceRoot });
          stderr.write('\x1b[2m[session] Auto-saved\x1b[0m\n');
        } catch {}
      }
      await stopBrain();
      console.log('Bye!');
      process.exit(0);

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
      if (planCtrl.getPlanMode?.()) {
        stderr.write('\x1b[33mAlready in plan mode. Use /execute to switch back.\x1b[0m\n');
      } else {
        planCtrl.setPlanMode?.(true);
        stderr.write('\x1b[33m🔒 Plan mode ON — read-only (write/edit/bash disabled)\x1b[0m\n');
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
      const files = undoStack.peek();
      const { relative } = await import('path');
      stderr.write(`\x1b[33m↩️  Undo last turn (${files.length} file${files.length > 1 ? 's' : ''}):\x1b[0m\n`);
      for (const f of files) {
        stderr.write(`  ${relative(config.workspaceRoot, f).split('\\').join('/')}\n`);
      }
      const result = undoStack.undo();
      if (result.restored.length) {
        stderr.write(`\x1b[32m✓ Restored: ${result.restored.map(f => relative(config.workspaceRoot, f).split('\\').join('/')).join(', ')}\x1b[0m\n`);
      }
      if (result.deleted.length) {
        stderr.write(`\x1b[32m✓ Deleted (were new): ${result.deleted.map(f => relative(config.workspaceRoot, f).split('\\').join('/')).join(', ')}\x1b[0m\n`);
      }
      if (result.conflicts?.length) {
        stderr.write(`\x1b[33m⚠️  Conflicts (files modified after agent edit): ${result.conflicts.map(f => relative(config.workspaceRoot, f).split('\\').join('/')).join(', ')}\x1b[0m\n`);
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
        if (all.length === 0) {
          stderr.write(`${DIM}No typed memories yet. Use /memory add <type> <name> <description>${R}\n`);
          stderr.write(`${DIM}Types: ${MEMORY_TYPES.join(', ')}. See /memory types for details.${R}\n`);
        } else {
          stderr.write(`\n${B}Typed Memories (${all.length}):${R}\n\n`);
          for (const type of MEMORY_TYPES) {
            const mems = all.filter(m => m.type === type);
            if (mems.length === 0) continue;
            stderr.write(`${C}  ${type} (${mems.length})${R}\n`);
            for (const m of mems) {
              const stale = m.staleWarning ? ` ${DIM}${m.staleWarning}${R}` : '';
              stderr.write(`    ${B}${m.name}${R}: ${DIM}${m.description.split('\n')[0].slice(0, 80)}${R}${stale}\n`);
            }
          }
          stderr.write('\n');
        }
      } else if (sub === 'types') {
        stderr.write(`\n${B}Memory Types:${R}\n\n`);
        const { MEMORY_TYPE_DESCRIPTIONS } = await import('../phase2/typed-memory.js');
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
          stderr.write(`\x1b[31mInvalid type '${type}'. Valid: ${MEMORY_TYPES.join(', ')}${R}\n`);
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
    try {
      const { providerId } = detectProvider(config.model);
      const provider = getProvider(providerId);

      if (!provider.supports?.listModels) {
        stderr.write(`\x1b[33mProvider '${providerId}' does not support model listing\x1b[0m\n`);
        console.log(`Current model: ${config.model} (via ${providerId})`);
        return;
      }

      const token = await getProviderToken(providerId);
      const url = resolveUrl(provider, 'models');
      const authHeaders = buildAuthHeaders(provider, token);

      const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json', ...authHeaders, ...provider.extraHeaders },
      });
      const data = await res.json();
      const models = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];

      console.log(`\nAvailable models (${providerId}):\n`);
      for (const m of models) {
        if (m.policy?.state !== 'enabled') continue;
        const current = config.model === m.id ? ' \x1b[32m← current\x1b[0m' : '';
        const ctx = m.capabilities?.limits?.max_context_window_tokens;
        const out = m.capabilities?.limits?.max_output_tokens;
        console.log(`  ${m.id}  (${ctx ? (ctx/1000)+'K ctx' : '?'}, ${out ? (out/1000)+'K out' : '?'})${current}`);
      }
      console.log('\nUse: /model <id>\n');
    } catch (err) {
      stderr.write(`\x1b[31mFailed to list models: ${err.message}\x1b[0m\n`);
    }
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
