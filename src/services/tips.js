// src/quick-wins/tips.js — Contextual tips during spinners
// Inspired by Claude Code's tips system (src/services/tips/)
// Shows helpful tips while the user waits for LLM responses.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const TIPS_FILE = join(homedir(), '.laia', 'tips.json');

// Bundled tips — shown during spinner waits
const BUNDLED_TIPS = [
  // Session management
  { id: 'compact', content: '💡 Usa /compact per alliberar context quan la sessió es fa llarga.' },
  { id: 'save', content: '💡 Usa /save <nom> per guardar la sessió i reprendre-la després amb /load.' },
  { id: 'fork', content: '💡 Usa /fork per crear una còpia de la sessió i explorar una idea sense perdre el fil.' },
  { id: 'effort', content: '💡 Usa /effort low per respostes ràpides, /effort max per tasques complexes.' },
  { id: 'plan', content: '💡 Usa /plan per mode read-only (sense escriptures) — ideal per explorar codi.' },

  // Tools & productivity
  { id: 'attach', content: '💡 Usa /attach fitxer.ts per mantenir un fitxer sempre al context.' },
  { id: 'model', content: '💡 Usa /model per canviar de model. Prova /model auto per routing intel·ligent.' },
  { id: 'skills', content: '💡 Usa /skills per veure totes les skills disponibles — tant built-in com custom.' },
  { id: 'agents', content: '💡 Crea agents especialitzats a ~/.laia/agents/ per tasques repetitives.' },
  { id: 'swarm', content: '💡 Usa /swarm per activar el mode multi-agent amb workers paral·lels.' },

  // Brain & memory
  { id: 'brain', content: '💡 LAIA recorda entre sessions — el brain guarda learnings, patrons i warnings.' },
  { id: 'reflect', content: '💡 Usa /reflect al final de la sessió per analitzar errors i millorar.' },

  // Git integration
  { id: 'commit', content: '💡 Usa /commit per generar un commit message automàtic basat en els canvis.' },
  { id: 'review', content: '💡 Usa /review <PR#> per fer code review d\'un Pull Request.' },
  { id: 'autocommit', content: '💡 Usa /autocommit per activar commits automàtics després de cada canvi.' },
  { id: 'undo', content: '💡 Usa /undo per revertir els canvis de l\'últim torn.' },

  // Debug
  { id: 'debug', content: '💡 Usa /debug per diagnosticar problemes amb la sessió o el brain.' },
  { id: 'tokens', content: '💡 Usa /tokens per veure l\'ús de tokens i quant context queda.' },

  // Multi-model
  { id: 'multimodel', content: '💡 Demana "revisa-ho amb Codex" per obtenir una segona opinió d\'un altre model.' },

  // Output
  { id: 'outputstyle', content: '💡 Crea fitxers .md a ~/.laia/output-styles/ per personalitzar l\'estil de resposta.' },
];

let _tips = null;
let _shownThisSession = new Set();

/**
 * Load tips: bundled + user custom from ~/.laia/tips.json
 */
function loadTips() {
  if (_tips) return _tips;

  let userTips = [];
  if (existsSync(TIPS_FILE)) {
    try {
      userTips = JSON.parse(readFileSync(TIPS_FILE, 'utf-8'));
      if (!Array.isArray(userTips)) userTips = [];
    } catch { userTips = []; }
  }

  _tips = [...BUNDLED_TIPS, ...userTips];
  return _tips;
}

/**
 * Get a random tip not yet shown this session.
 * Returns null if all tips have been shown.
 */
export function getRandomTip() {
  const tips = loadTips();
  const available = tips.filter(t => !_shownThisSession.has(t.id));

  if (available.length === 0) {
    // Reset pool when exhausted
    _shownThisSession.clear();
    return tips[Math.floor(Math.random() * tips.length)];
  }

  const tip = available[Math.floor(Math.random() * available.length)];
  _shownThisSession.add(tip.id);
  return tip;
}

/**
 * Reset shown tips (e.g. new session)
 */
export function resetTips() {
  _shownThisSession.clear();
  _tips = null;
}

/**
 * Create default tips.json template
 */
export function initTipsFile() {
  if (existsSync(TIPS_FILE)) return;
  const dir = join(homedir(), '.laia');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const template = [
    { id: 'custom-example', content: '💡 This is a custom tip — edit ~/.laia/tips.json to add your own!' }
  ];
  writeFileSync(TIPS_FILE, JSON.stringify(template, null, 2), 'utf-8');
}
