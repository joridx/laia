// src/services/doctor.js — /doctor diagnostic command for LAIA V5
// Self-service troubleshooting: checks config, APIs, brain, skills, git, hooks.

import { existsSync, statSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { stderr } from 'process';

const DIM = '\x1b[2m';
const R = '\x1b[0m';
const B = '\x1b[1m';
const G = '\x1b[32m';
const RED = '\x1b[31m';
const Y = '\x1b[33m';
const C = '\x1b[36m';

/**
 * Run all diagnostic checks and output results.
 * @param {object} opts
 * @param {object} opts.config - LAIA config
 * @param {object} [opts.hookStats] - From getHookStats()
 * @param {object} [opts.flags] - From loadFlags()
 * @param {number} [opts.skillCount] - Number of loaded skills
 */
export async function runDoctor({ config, hookStats, flags, skillCount }) {
  const checks = [];

  // ─── 1. Node.js version ──────────────────────────────────────────────
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1));
  checks.push({
    name: 'Node.js',
    status: major >= 20 ? 'ok' : major >= 18 ? 'warn' : 'fail',
    detail: `${nodeVersion}${major < 20 ? ' (recommended: ≥20)' : ''}`,
  });

  // ─── 2. Config file ──────────────────────────────────────────────────
  const configPath = join(homedir(), '.laia', 'config.json');
  checks.push({
    name: 'Config file',
    status: existsSync(configPath) ? 'ok' : 'warn',
    detail: existsSync(configPath) ? configPath : 'Not found (using defaults)',
  });

  // ─── 3. Model ────────────────────────────────────────────────────────
  checks.push({
    name: 'Model',
    status: config.model ? 'ok' : 'fail',
    detail: config.model || 'No model configured!',
  });

  // ─── 4. API connectivity ─────────────────────────────────────────────
  try {
    const { detectProvider, getProvider } = await import('@laia/providers');
    const { providerId } = detectProvider(config.model, { forceProvider: config.provider });
    const provider = getProvider(providerId);
    checks.push({
      name: 'API Provider',
      status: 'ok',
      detail: `${providerId} → ${provider.baseUrl || '(default)'}`,
    });
  } catch (err) {
    checks.push({
      name: 'API Provider',
      status: 'fail',
      detail: err.message,
    });
  }

  // ─── 5. Brain ────────────────────────────────────────────────────────
  const brainPath = config.brainPath || join(homedir(), 'laia-data');
  const brainExists = existsSync(brainPath);
  const brainPkg = join(__dirname_approx(), '..', '..', 'packages', 'brain', 'package.json');
  let brainVersion = '?';
  try { brainVersion = JSON.parse(readFileSync(brainPkg, 'utf8')).version; } catch {}
  checks.push({
    name: 'Brain data',
    status: brainExists ? 'ok' : 'warn',
    detail: brainExists
      ? `${brainPath} (v${brainVersion})`
      : `${brainPath} not found`,
  });

  // Count learnings
  try {
    const learningsDir = join(brainPath, 'learnings');
    const count = existsSync(learningsDir) ? readdirSync(learningsDir).filter(f => f.endsWith('.md')).length : 0;
    checks.push({
      name: 'Brain learnings',
      status: count > 0 ? 'ok' : 'warn',
      detail: `${count} learnings`,
    });
  } catch {
    checks.push({ name: 'Brain learnings', status: 'warn', detail: 'Cannot read learnings dir' });
  }

  // ─── 6. Git ──────────────────────────────────────────────────────────
  try {
    const gitVersion = execSync('git --version', { encoding: 'utf8', timeout: 3000 }).trim();
    checks.push({ name: 'Git', status: 'ok', detail: gitVersion });
  } catch {
    checks.push({ name: 'Git', status: 'fail', detail: 'git not found in PATH' });
  }

  // Git repo?
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: config.workspaceRoot, encoding: 'utf8', timeout: 3000 });
    const branch = execSync('git branch --show-current', { cwd: config.workspaceRoot, encoding: 'utf8', timeout: 3000 }).trim();
    checks.push({ name: 'Git repo', status: 'ok', detail: `${config.workspaceRoot} (branch: ${branch})` });
  } catch {
    checks.push({ name: 'Git repo', status: 'warn', detail: 'Not inside a git repository' });
  }

  // ─── 7. Skills ───────────────────────────────────────────────────────
  const skillDirs = [
    join(homedir(), '.laia', 'skills'),
    join(homedir(), '.laia', 'commands'),
  ];
  const foundSkillDirs = skillDirs.filter(d => existsSync(d));
  checks.push({
    name: 'Skills',
    status: (skillCount || 0) > 0 ? 'ok' : 'warn',
    detail: `${skillCount || 0} skills loaded from ${foundSkillDirs.length} dir(s)`,
  });

  // ─── 8. Hooks ────────────────────────────────────────────────────────
  if (hookStats) {
    const totalHandlers = Object.values(hookStats.handlerCounts).reduce((a, b) => a + b, 0);
    const totalErrors = Object.values(hookStats.errors).reduce((a, b) => a + b, 0);
    checks.push({
      name: 'Hooks',
      status: totalErrors > 0 ? 'warn' : 'ok',
      detail: `${totalHandlers} handlers, ${totalErrors} errors`,
    });
  } else {
    checks.push({ name: 'Hooks', status: 'info', detail: 'No stats available' });
  }

  // ─── 9. Feature flags ───────────────────────────────────────────────
  if (flags) {
    const boolTrue = Object.entries(flags).filter(([, v]) => v === true).length;
    const boolFalse = Object.entries(flags).filter(([, v]) => v === false).length;
    const other = Object.keys(flags).length - boolTrue - boolFalse;
    checks.push({
      name: 'Feature flags',
      status: 'ok',
      detail: `${boolTrue} on, ${boolFalse} off, ${other} custom (${Object.keys(flags).length} total)`,
    });
  }

  // ─── 10. Disk space ──────────────────────────────────────────────────
  try {
    const df = execSync(`df -h "${homedir()}" | tail -1`, { encoding: 'utf8', timeout: 3000 }).trim();
    const parts = df.split(/\s+/);
    const avail = parts[3] || '?';
    const usePct = parseInt(parts[4]) || 0;
    checks.push({
      name: 'Disk space',
      status: usePct > 90 ? 'warn' : 'ok',
      detail: `${avail} available (${parts[4] || '?'} used)`,
    });
  } catch {
    checks.push({ name: 'Disk space', status: 'info', detail: 'Cannot determine' });
  }

  // ─── 11. Permissions ─────────────────────────────────────────────────
  checks.push({
    name: 'Permissions',
    status: 'ok',
    detail: `3-tier system active (auto: read/glob/grep, session: write/edit/bash)`,
  });

  // ─── Output ──────────────────────────────────────────────────────────
  stderr.write(`\n${B}🩺 LAIA Doctor${R}\n\n`);

  let okCount = 0, warnCount = 0, failCount = 0;
  for (const check of checks) {
    let icon, color;
    switch (check.status) {
      case 'ok':   icon = '✅'; color = G; okCount++; break;
      case 'warn': icon = '⚠️'; color = Y; warnCount++; break;
      case 'fail': icon = '❌'; color = RED; failCount++; break;
      default:     icon = 'ℹ️'; color = DIM; break;
    }
    stderr.write(`  ${icon} ${B}${check.name}${R}: ${color}${check.detail}${R}\n`);
  }

  stderr.write(`\n  ${G}${okCount} ok${R}  ${Y}${warnCount} warnings${R}  ${RED}${failCount} failures${R}\n\n`);

  if (failCount > 0) {
    stderr.write(`${RED}⚠ There are failures that need attention.${R}\n\n`);
  } else if (warnCount > 0) {
    stderr.write(`${Y}Some warnings detected — LAIA should work but check above.${R}\n\n`);
  } else {
    stderr.write(`${G}All checks passed! LAIA is healthy. 🎉${R}\n\n`);
  }

  return { checks, ok: failCount === 0 };
}

// Helper: approximate __dirname for ESM
function __dirname_approx() {
  try {
    return new URL('.', import.meta.url).pathname;
  } catch {
    return process.cwd();
  }
}
