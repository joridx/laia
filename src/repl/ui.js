// src/repl/ui.js
// UI utilities extracted from repl.js — banner, suggestions, prompts

import { stderr } from 'process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadMemoryFiles } from '../memory-files.js';

const __dirname_ui = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = JSON.parse(readFileSync(join(__dirname_ui, '..', '..', 'package.json'), 'utf8')).version;

export { PKG_VERSION };

const CAT_POSES = [
  { l1: ' /\\_/\\', l2: '( ◦.◦ )', l3: '  >‿<' },
  { l1: ' /\\_/\\', l2: '( -.◦ )', l3: '  >‿<' },
  { l1: ' /\\_/\\', l2: '( ^.^ )', l3: '  >‿<' },
  { l1: ' /\\_/\\', l2: '( ◦.- )', l3: '  >‿<' },
  { l1: ' /\\_/\\', l2: '( ◦_◦ )', l3: '  >‿<' },
  { l1: ' /\\_/\\', l2: '( -.- )', l3: '  >‿<' },
];

export async function animateCatBanner(config, planMode, fileCommands) {
  const R = '\x1b[0m';
  const CAT = '\x1b[38;2;167;139;250m';
  const CATB = '\x1b[1m\x1b[38;2;167;139;250m';
  const DIM = '\x1b[2m';

  const modelLabel = config.model === 'auto' ? 'auto (routing)' : config.model;
  const modeLabel = planMode ? ' \x1b[33m[PLAN]\x1b[0m' : '';
  const cwd = config.workspaceRoot?.replace(process.env.HOME, '~') || '.';

  const renderFrame = (pose) => {
    const p = CAT_POSES[pose] || CAT_POSES[0];
    return [
      `${CAT}${p.l1}${R}   ${CATB}LAIA${R} v${PKG_VERSION}${modeLabel}`,
      `${CAT}${p.l2}${R}   ${DIM}${modelLabel}${R}`,
      `${CAT}${p.l3}${R}    ${DIM}${cwd}${R}`,
    ];
  };

  const sequence = [0, 0, 1, 0, 3, 0, 2];
  const delays = [200, 150, 80, 150, 80, 150, 0];
  const canAnimate = stderr.isTTY && !process.env.CI;

  if (canAnimate) {
    const lines = renderFrame(sequence[0]);
    stderr.write('\n');
    for (const line of lines) stderr.write(line + '\n');
    stderr.write('\n');
    for (let i = 1; i < sequence.length; i++) {
      await new Promise(r => setTimeout(r, delays[i - 1]));
      const frame = renderFrame(sequence[i]);
      stderr.write('\x1b[4A');
      for (const line of frame) stderr.write('\x1b[2K' + line + '\n');
      stderr.write('\x1b[2K\n');
    }
  } else {
    const lines = renderFrame(2);
    stderr.write('\n');
    for (const line of lines) stderr.write(line + '\n');
    stderr.write('\n');
  }

  const memFiles = loadMemoryFiles({ workspaceRoot: config.workspaceRoot });
  if (memFiles.length) {
    for (const f of memFiles) {
      stderr.write(`\x1b[2m  📋 ${f.level}: ${f.path}\x1b[0m\n`);
    }
  }

  const skillNames = fileCommands ? [...fileCommands.keys()] : [];
  if (skillNames.length >= 2) {
    const seed = new Date().getMinutes();
    const shuffled = skillNames.slice().sort((a, b) => {
      const ha = ((seed * 31 + a.charCodeAt(0)) * 37) & 0xffff;
      const hb = ((seed * 31 + b.charCodeAt(0)) * 37) & 0xffff;
      return ha - hb;
    });
    const tips = shuffled.slice(0, 3).map(s => `/${s}`);
    stderr.write(`\x1b[2m  💡 ${tips.join(' · ')} · /help\x1b[0m\n`);
  }
}

export function suggestFollowUps(text) {
  if (!text) return [];
  const s = [];
  if (/error|fail|exception|bug|issue/i.test(text)) {
    s.push('Explain the root cause');
    s.push('Fix this issue');
    s.push('Add a test to prevent this');
  } else if (/created|wrote|written|saved/i.test(text)) {
    s.push('Read the file to verify');
    s.push('Run tests');
    s.push('What should I do next?');
  } else if (/found|match|result|files?:/i.test(text)) {
    s.push('Show me the most relevant one');
    s.push('Summarize the findings');
    s.push('Search for something else');
  } else if (/plan|steps|approach|architecture/i.test(text)) {
    s.push('Implement step 1');
    s.push('What are the edge cases?');
    s.push('Turn this into a checklist');
  } else {
    s.push('Tell me more');
    s.push('Show the code');
    s.push('What should I do next?');
  }
  return s.slice(0, 3);
}
