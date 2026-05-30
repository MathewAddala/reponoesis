/**
 * `engine check` — Pre-commit / on-demand chain break detector
 *
 * This is the command that runs in the pre-commit hook.
 * It:
 *   1. Gets the git diff (staged changes)
 *   2. Incremental re-indexes the changed files
 *   3. Runs blast radius query
 *   4. Groups results by severity
 *   5. Prints the report
 *   6. Exits with code 1 if critical/high chains are broken
 */

import chalk from 'chalk';
import { simpleGit } from 'simple-git';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { Indexer } from '@engine/core';
import type { AbsPath } from '@engine/core';

interface CheckOptions {
  json: boolean;
  failOn: 'critical' | 'high' | 'medium' | 'any';
}

const SEVERITY_ORDER = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
const SEVERITY_EMOJI = { CRITICAL: '🚨', HIGH: '⚠️ ', MEDIUM: '🔶', LOW: '🔵' };
const SEVERITY_COLOR = {
  CRITICAL: chalk.red.bold,
  HIGH: chalk.yellow.bold,
  MEDIUM: chalk.yellow,
  LOW: chalk.blue,
};

export async function checkCommand(options: CheckOptions): Promise<void> {
  const cwd = process.cwd();
  const configPath = resolve(cwd, '.engine', 'config.json');

  if (!existsSync(configPath)) {
    console.error(chalk.red('❌ Engine not initialized. Run: engine init'));
    process.exit(1);
  }

  const config = loadConfig(cwd);
  const git = simpleGit(cwd);

  // Get staged file paths
  let stagedFiles: string[] = [];
  try {
    const diff = await git.diff(['--cached', '--name-only']);
    stagedFiles = diff
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(f => resolve(cwd, f));
  } catch {
    // Not in git repo or no staged files
    stagedFiles = [];
  }

  if (stagedFiles.length === 0) {
    if (!options.json) {
      console.log(chalk.green('✓ No staged changes to check.'));
    } else {
      console.log(JSON.stringify({ status: 'clean', broken: 0 }));
    }
    process.exit(0);
  }

  const indexer = new Indexer(config);
  const startMs = Date.now();

  // Re-index changed files
  await indexer.incrementalScan(stagedFiles as AbsPath[]);

  // Get impact map
  const impact = indexer.getImpactMap(stagedFiles as AbsPath[]);
  const brokenChains = indexer.getBrokenForFiles(stagedFiles as AbsPath[]);
  const durationMs = Date.now() - startMs;

  indexer.close();

  if (options.json) {
    console.log(JSON.stringify({ impact, brokenChains, durationMs }, null, 2));
    const hasCritical = brokenChains.some(b => b.severity === 'CRITICAL');
    const hasHigh = brokenChains.some(b => b.severity === 'HIGH');
    if (options.failOn === 'critical' && hasCritical) process.exit(1);
    if (options.failOn === 'high' && (hasCritical || hasHigh)) process.exit(1);
    process.exit(0);
  }

  // ── Pretty print ────────────────────────────────────────────────────────────

  console.log('');
  console.log(chalk.bold.cyan('⛓️  ENGINE — Semantic Chain Integrity Check'));
  console.log(chalk.dim(`   Analyzing ${stagedFiles.length} staged file(s)...`));
  console.log('');

  // Changed files
  for (const f of stagedFiles) {
    const rel = f.replace(cwd + '/', '');
    console.log(`  ${chalk.green('✓')} ${chalk.dim(rel)}`);
  }
  console.log('');

  if (brokenChains.length === 0) {
    console.log(chalk.green.bold('  ✓ All semantic chains intact. Safe to commit.\n'));
    process.exit(0);
  }

  // Group by severity
  const bySeverity = {
    CRITICAL: brokenChains.filter(b => b.severity === 'CRITICAL'),
    HIGH: brokenChains.filter(b => b.severity === 'HIGH'),
    MEDIUM: brokenChains.filter(b => b.severity === 'MEDIUM'),
    LOW: brokenChains.filter(b => b.severity === 'LOW'),
  };

  for (const sev of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const) {
    const items = bySeverity[sev];
    if (items.length === 0) continue;

    const color = SEVERITY_COLOR[sev];
    const emoji = SEVERITY_EMOJI[sev];

    console.log(color(`  ${emoji} ${sev} — ${items.length} broken chain(s):`));

    for (const item of items) {
      const relPath = item.filePath.replace(cwd + '/', '');
      console.log(`     ${chalk.white('→')} ${chalk.underline(relPath)}${chalk.dim(`:${item.lineStart}-${item.lineEnd}`)}`);
      console.log(`       ${chalk.dim(item.reason)}`);
      console.log(`       ${chalk.dim(`Concept: "${item.conceptLabel}" — chain link: ${item.chainLink.slice(0, 16)}...`)}`);
    }
    console.log('');
  }

  const critCount = bySeverity.CRITICAL.length;
  const highCount = bySeverity.HIGH.length;
  const totalBroken = brokenChains.length;

  console.log(chalk.dim(`  Scanned in ${durationMs}ms`));
  console.log('');

  // Gatekeeper decision
  const shouldBlock =
    (options.failOn === 'critical' && critCount > 0) ||
    (options.failOn === 'high' && (critCount + highCount) > 0) ||
    (options.failOn === 'medium' && totalBroken > 0);

  if (shouldBlock) {
    console.log(chalk.red.bold('  ✗ Commit BLOCKED — resolve broken chains before committing.'));
    console.log('');
    console.log(chalk.dim('  Options:'));
    console.log(chalk.dim('    engine review          — interactive resolution'));
    console.log(chalk.dim('    engine check --fail-on medium   — adjust sensitivity'));
    console.log('');
    process.exit(1);
  } else {
    console.log(chalk.yellow('  ⚠ Commit allowed — non-critical chains detected. Consider reviewing.'));
    console.log('');
    process.exit(0);
  }
}
