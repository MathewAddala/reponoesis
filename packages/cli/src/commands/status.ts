/**
 * `engine status` — Chain health dashboard
 */

import chalk from 'chalk';
import boxen from 'boxen';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { Indexer } from '@engine/core';

interface StatusOptions {
  broken: boolean;
}

export async function statusCommand(options: StatusOptions): Promise<void> {
  const cwd = process.cwd();

  if (!existsSync(resolve(cwd, '.engine', 'config.json'))) {
    console.error(chalk.red('❌ Engine not initialized. Run: engine init'));
    process.exit(1);
  }

  const config = loadConfig(cwd);
  const indexer = new Indexer(config);
  const summary = indexer.getHealthSummary();
  const brokenConcepts = options.broken ? indexer.getAllBrokenChains() : [];
  indexer.close();

  const healthPct = summary.totalConcepts > 0
    ? Math.round((summary.validChains / summary.totalConcepts) * 100)
    : 100;

  const healthColor = healthPct === 100 ? chalk.green : healthPct > 85 ? chalk.yellow : chalk.red;

  const dashboard = [
    chalk.bold.cyan('⛓️  ENGINE — Chain Health Dashboard'),
    '',
    `  Files indexed:     ${chalk.white(summary.totalFiles)}`,
    `  Concepts tracked:  ${chalk.white(summary.totalConcepts)}`,
    `  Dependency edges:  ${chalk.white(summary.totalEdges)}`,
    '',
    `  Chain Health:      ${healthColor.bold(`${healthPct}%`)}`,
    `  ✓ Valid:           ${chalk.green(summary.validChains)}`,
    summary.brokenChains > 0
      ? `  ✗ Broken:          ${chalk.red.bold(summary.brokenChains)}`
      : `  ✗ Broken:          ${chalk.green('0')}`,
    summary.acknowledgedDrift > 0
      ? `  ~ Acknowledged:    ${chalk.yellow(summary.acknowledgedDrift)}`
      : '',
  ].filter(Boolean).join('\n');

  console.log('');
  console.log(boxen(dashboard, {
    padding: 1,
    margin: 1,
    borderStyle: 'round',
    borderColor: healthPct === 100 ? 'green' : healthPct > 85 ? 'yellow' : 'red',
  }));

  if (options.broken && brokenConcepts.length > 0) {
    console.log(chalk.red.bold('  Broken Chains:\n'));
    for (const concept of brokenConcepts) {
      const relPath = concept.filePath.replace(process.cwd() + '\\', '').replace(process.cwd() + '/', '');
      console.log(`  ${chalk.red('✗')} ${chalk.underline(relPath)}${chalk.dim(`:${concept.lineStart}`)}`);
      console.log(`    ${chalk.dim(`Concept: "${concept.conceptLabel}" — chain: ${concept.chainLink ? concept.chainLink.slice(0, 16) + '...' : '(pending)'}`)}`);
    }
    console.log('');
    console.log(chalk.dim('  Run: engine review  — to resolve'));
    console.log('');
  }
}
