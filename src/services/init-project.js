// src/services/init-project.js — /init: Generate LAIA.md for current project
// Scans repo structure to infer stack, conventions, and commands.

import { existsSync, readFileSync, readdirSync, writeFileSync, statSync } from 'fs';
import { join, basename } from 'path';
import { execSync } from 'child_process';
import { stderr } from 'process';

const B = '\x1b[1m';
const G = '\x1b[32m';
const Y = '\x1b[33m';
const DIM = '\x1b[2m';
const R = '\x1b[0m';

/**
 * Detect project stack and metadata by scanning common files.
 * @param {string} root - Workspace root
 * @returns {object} Detected metadata
 */
function detectStack(root) {
  const meta = {
    name: basename(root),
    languages: [],
    frameworks: [],
    buildTools: [],
    testTools: [],
    hasGit: false,
    branch: null,
    packageManager: null,
    scripts: {},
    entryPoint: null,
    srcDirs: [],
    testDirs: [],
    configFiles: [],
  };

  // Git
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: root, stdio: 'pipe' });
    meta.hasGit = true;
    meta.branch = execSync('git branch --show-current', { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {}

  // package.json (Node.js)
  const pkgPath = join(root, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      meta.name = pkg.name || meta.name;
      meta.languages.push('JavaScript/TypeScript');
      meta.entryPoint = pkg.main || pkg.module || 'index.js';

      // Scripts
      if (pkg.scripts) {
        meta.scripts = pkg.scripts;
        if (pkg.scripts.test) meta.testTools.push(detectTestRunner(pkg.scripts.test));
        if (pkg.scripts.build) meta.buildTools.push('npm build');
        if (pkg.scripts.lint) meta.buildTools.push('npm lint');
      }

      // Frameworks from deps
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps.react) meta.frameworks.push('React');
      if (allDeps.vue) meta.frameworks.push('Vue');
      if (allDeps.next) meta.frameworks.push('Next.js');
      if (allDeps.express) meta.frameworks.push('Express');
      if (allDeps.fastify) meta.frameworks.push('Fastify');
      if (allDeps.typescript) meta.languages.push('TypeScript');
      if (allDeps.jest) meta.testTools.push('Jest');
      if (allDeps.vitest) meta.testTools.push('Vitest');
      if (allDeps.mocha) meta.testTools.push('Mocha');
    } catch {}
  }

  // Package manager
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bunfig.toml'))) meta.packageManager = 'bun';
  else if (existsSync(join(root, 'pnpm-lock.yaml'))) meta.packageManager = 'pnpm';
  else if (existsSync(join(root, 'yarn.lock'))) meta.packageManager = 'yarn';
  else if (existsSync(join(root, 'package-lock.json'))) meta.packageManager = 'npm';

  // Python
  if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'setup.py')) || existsSync(join(root, 'requirements.txt'))) {
    meta.languages.push('Python');
    if (existsSync(join(root, 'pyproject.toml'))) {
      try {
        const pyproj = readFileSync(join(root, 'pyproject.toml'), 'utf8');
        if (pyproj.includes('django')) meta.frameworks.push('Django');
        if (pyproj.includes('flask')) meta.frameworks.push('Flask');
        if (pyproj.includes('fastapi')) meta.frameworks.push('FastAPI');
        if (pyproj.includes('pytest')) meta.testTools.push('pytest');
      } catch {}
    }
  }

  // Go
  if (existsSync(join(root, 'go.mod'))) {
    meta.languages.push('Go');
  }

  // Rust
  if (existsSync(join(root, 'Cargo.toml'))) {
    meta.languages.push('Rust');
    meta.buildTools.push('cargo');
    meta.testTools.push('cargo test');
  }

  // Java/Kotlin
  if (existsSync(join(root, 'pom.xml'))) {
    meta.languages.push('Java');
    meta.buildTools.push('Maven');
  }
  if (existsSync(join(root, 'build.gradle')) || existsSync(join(root, 'build.gradle.kts'))) {
    meta.languages.push(existsSync(join(root, 'build.gradle.kts')) ? 'Kotlin' : 'Java');
    meta.buildTools.push('Gradle');
  }

  // Docker
  if (existsSync(join(root, 'Dockerfile')) || existsSync(join(root, 'docker-compose.yml'))) {
    meta.buildTools.push('Docker');
  }

  // Config files
  const configPatterns = ['tsconfig.json', '.eslintrc*', '.prettierrc*', 'biome.json', '.editorconfig', 'Makefile'];
  try {
    for (const f of readdirSync(root)) {
      if (configPatterns.some(p => {
        if (p.endsWith('*')) return f.startsWith(p.slice(0, -1));
        return f === p;
      })) {
        meta.configFiles.push(f);
      }
    }
  } catch {}

  // Detect src/test dirs
  for (const dir of ['src', 'lib', 'app', 'packages', 'cmd', 'internal']) {
    if (existsSync(join(root, dir)) && statSync(join(root, dir)).isDirectory()) {
      meta.srcDirs.push(dir);
    }
  }
  for (const dir of ['test', 'tests', '__tests__', 'spec', 'e2e']) {
    if (existsSync(join(root, dir)) && statSync(join(root, dir)).isDirectory()) {
      meta.testDirs.push(dir);
    }
  }

  return meta;
}

function detectTestRunner(script) {
  if (script.includes('jest')) return 'Jest';
  if (script.includes('vitest')) return 'Vitest';
  if (script.includes('mocha')) return 'Mocha';
  if (script.includes('node --test')) return 'Node.js test runner';
  if (script.includes('pytest')) return 'pytest';
  return 'custom';
}

/**
 * Generate LAIA.md content from detected metadata.
 */
function generateLaiamd(meta) {
  const lines = [];
  lines.push(`# ${meta.name} — Project Context for LAIA`);
  lines.push('');
  lines.push(`> Auto-generated by \`/init\` on ${new Date().toISOString().split('T')[0]}`);
  lines.push('');

  // Stack
  lines.push('## Stack');
  lines.push('');
  if (meta.languages.length) lines.push(`- **Languages:** ${[...new Set(meta.languages)].join(', ')}`);
  if (meta.frameworks.length) lines.push(`- **Frameworks:** ${[...new Set(meta.frameworks)].join(', ')}`);
  if (meta.packageManager) lines.push(`- **Package manager:** ${meta.packageManager}`);
  if (meta.buildTools.length) lines.push(`- **Build tools:** ${[...new Set(meta.buildTools)].join(', ')}`);
  if (meta.testTools.length) lines.push(`- **Testing:** ${[...new Set(meta.testTools)].join(', ')}`);
  lines.push('');

  // Structure
  lines.push('## Structure');
  lines.push('');
  if (meta.srcDirs.length) lines.push(`- **Source:** ${meta.srcDirs.map(d => `\`${d}/\``).join(', ')}`);
  if (meta.testDirs.length) lines.push(`- **Tests:** ${meta.testDirs.map(d => `\`${d}/\``).join(', ')}`);
  if (meta.entryPoint) lines.push(`- **Entry point:** \`${meta.entryPoint}\``);
  if (meta.configFiles.length) lines.push(`- **Config:** ${meta.configFiles.map(f => `\`${f}\``).join(', ')}`);
  lines.push('');

  // Commands
  if (Object.keys(meta.scripts).length > 0) {
    lines.push('## Useful Commands');
    lines.push('');
    const important = ['build', 'test', 'dev', 'start', 'lint', 'format', 'typecheck', 'deploy'];
    for (const key of important) {
      if (meta.scripts[key]) {
        lines.push(`- \`${meta.packageManager || 'npm'} run ${key}\` — ${meta.scripts[key]}`);
      }
    }
    lines.push('');
  }

  // Git
  if (meta.hasGit) {
    lines.push('## Git');
    lines.push('');
    lines.push(`- **Branch:** ${meta.branch || '(detached)'}`);
    lines.push('');
  }

  // Conventions placeholder
  lines.push('## Conventions');
  lines.push('');
  lines.push('<!-- Add project-specific conventions here -->');
  lines.push('- Follow existing code style');
  lines.push('- Write tests for new features');
  lines.push('- Use meaningful commit messages');
  lines.push('');

  return lines.join('\n');
}

/**
 * Run /init — detect, generate, optionally write.
 * @param {object} opts
 * @param {string} opts.workspaceRoot
 * @param {boolean} [opts.dryRun=false] - Print without writing
 * @param {string} [opts.target] - Where to write ('project' | 'dotlaia')
 * @returns {{ content: string, written: string|null }}
 */
export async function runInit({ workspaceRoot, dryRun = false, target = 'dotlaia', force = false }) {
  stderr.write(`${DIM}[init] Scanning ${workspaceRoot}...${R}\n`);
  const meta = detectStack(workspaceRoot);
  const content = generateLaiamd(meta);

  if (dryRun) {
    stderr.write(`\n${B}Generated LAIA.md:${R}\n\n${content}\n`);
    return { content, written: null };
  }

  // Determine target path
  let outPath;
  if (target === 'dotlaia') {
    const dir = join(workspaceRoot, '.laia');
    const { mkdirSync } = await import('fs');
    mkdirSync(dir, { recursive: true });
    outPath = join(dir, 'LAIA.md');
  } else {
    outPath = join(workspaceRoot, 'LAIA.md');
  }

  // Check if already exists
  if (existsSync(outPath) && !force) {
    stderr.write(`${Y}⚠ ${outPath} already exists. Use /init --force to overwrite.${R}\n`);
    stderr.write(`${DIM}Preview:${R}\n\n${content}\n`);
    return { content, written: null };
  }

  writeFileSync(outPath, content);
  stderr.write(`${G}✅ Created ${outPath}${R}\n`);
  stderr.write(`${DIM}Edit it to add project-specific conventions and notes.${R}\n`);
  return { content, written: outPath };
}
