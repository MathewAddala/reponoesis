#!/usr/bin/env node
/**
 * Reponoesis — One-shot installer
 * Run: node install.mjs
 * 
 * What this does:
 *   1. Checks Node 18+
 *   2. npm install
 *   3. npm run build
 *   4. npm link on cli + mcp packages
 *   5. Verifies rpn and rpn-mcp are on PATH
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const run = (cmd, opts = {}) => {
  console.log(`\n  > ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', cwd: opts.cwd ?? __dirname, ...opts });
};

const check = (cmd) => {
  try { execSync(cmd, { stdio: 'pipe' }); return true; } catch { return false; }
};

console.log('\n  ╔══════════════════════════════════════╗');
console.log('  ║  Reponoesis (rpn) — Installer        ║');
console.log('  ╚══════════════════════════════════════╝\n');

// 1. Node version check
const nodeVer = parseInt(process.version.slice(1));
if (nodeVer < 18) {
  console.error(`  ✗ Node 18+ required. You have ${process.version}`);
  console.error('  → Install from https://nodejs.org');
  process.exit(1);
}
console.log(`  ✓ Node ${process.version}`);

// 2. npm install
console.log('\n  [1/4] Installing dependencies...');
run('npm install');

// 3. Build
console.log('\n  [2/4] Building packages...');
run('npm run build');

// 4. Link CLI
console.log('\n  [3/4] Linking rpn CLI globally...');
run('npm link', { cwd: resolve(__dirname, 'packages', 'cli') });

// 5. Link MCP
console.log('\n  [4/4] Linking rpn-mcp server globally...');
run('npm link', { cwd: resolve(__dirname, 'packages', 'mcp') });

// 6. Verify
console.log('\n  ─────────────────────────────────────────');
const rpnOk = check('rpn --version');
const mcpOk = check('rpn-mcp --help');
console.log(`  ${rpnOk ? '✓' : '✗'} rpn CLI:       ${rpnOk ? 'available' : 'NOT FOUND — restart your terminal'}`);
console.log(`  ${mcpOk ? '✓' : '✗'} rpn-mcp:      ${mcpOk ? 'available' : 'NOT FOUND — restart your terminal'}`);

if (rpnOk && mcpOk) {
  console.log('\n  ✅ Reponoesis installed successfully!\n');
  console.log('  Next steps:');
  console.log('    cd /your/project');
  console.log('    rpn init                   ← initialize Reponoesis');
  console.log('    rpn scan                   ← index your project');
  console.log('    rpn status                 ← see chain health');
  console.log('\n  For AI agents (Cursor / Claude Code / Gemini):');
  console.log('  Add to your mcp config:');
  console.log('  {');
  console.log('    "rpn": {');
  console.log('      "command": "rpn-mcp",');
  console.log('      "args": ["--project", "/abs/path/to/your/project"]');
  console.log('    }');
  console.log('  }');
  console.log('\n  Then in your agent session — call: rpn_get_context() first!\n');
} else {
  console.log('\n  ⚠ Installed but PATH may need updating. Restart your terminal and run:');
  console.log('    rpn --version');
}
