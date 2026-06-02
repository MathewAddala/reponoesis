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
    console.error(chalk.red('[ERROR] Reponoesis not initialized. Run: rpn init'));
    process.exit(1);
  }

  const config = loadConfig(cwd);
  const indexer = new Indexer(config);
  const summary = indexer.getHealthSummary();
  const semanticViolationsList = indexer.getSemanticViolations();
  const brokenConcepts = options.broken ? indexer.getAllBrokenChains() : [];
  const violationsWithDetails = indexer.getSemanticViolationsWithDetails();
  indexer.close();

  const healthPct = (summary.totalConcepts + semanticViolationsList.length) > 0
    ? Math.round((summary.validChains / (summary.totalConcepts + semanticViolationsList.length)) * 100)
    : 100;

  const healthColor = healthPct === 100 ? chalk.green : healthPct > 85 ? chalk.yellow : chalk.red;

  const dashboard = [
    chalk.bold.cyan('[RPN] REPONOESIS — Chain Health Dashboard'),
    '',
    `  Files indexed:     ${chalk.white(summary.totalFiles)}`,
    `  Concepts tracked:  ${chalk.white(summary.totalConcepts)}`,
    `  Dependency edges:  ${chalk.white(summary.totalEdges)}`,
    '',
    `  Chain Health:      ${healthColor.bold(`${healthPct}%`)}`,
    `  [OK] Valid:           ${chalk.green(summary.validChains)}`,
    summary.brokenChains > 0
      ? `  [DRIFT] Broken:          ${chalk.red.bold(summary.brokenChains)}`
      : `  [DRIFT] Broken:          ${chalk.green('0')}`,
    semanticViolationsList.length > 0
      ? `  [CONTRADICTION] Active:  ${chalk.red.bold(semanticViolationsList.length)}`
      : `  [CONTRADICTION] Active:  ${chalk.green('0')}`,
    summary.acknowledgedDrift > 0
      ? `  [ACK] Acknowledged:    ${chalk.yellow(summary.acknowledgedDrift)}`
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
      console.log(`  ${chalk.red('[DRIFT]')} ${chalk.underline(relPath)}${chalk.dim(`:${concept.lineStart}`)}`);
      console.log(`    ${chalk.dim(`Concept: "${concept.conceptLabel}" — chain: ${concept.chainLink ? concept.chainLink.slice(0, 16) + '...' : '(pending)'}`)}`);
    }
    console.log('');
    console.log(chalk.dim('  Run: rpn review  — to resolve'));
    console.log('');
  }

  if (options.broken && violationsWithDetails.length > 0) {
    console.log(chalk.red.bold('  Active Semantic Contradictions:\n'));
    for (const v of violationsWithDetails) {
      const relA = v.fileAPath.replace(cwd + '\\', '').replace(cwd + '/', '');
      const relB = v.fileBPath.replace(cwd + '\\', '').replace(cwd + '/', '');
      console.log(`  ${chalk.red('[CONTRADICTION]')} ${chalk.bold.yellow(`Concept: "${v.conceptLabel}"`)}`);
      console.log(`    File A:   ${chalk.underline(relA)}${chalk.dim(`:${v.lineStartA}`)}`);
      console.log(`    File B:   ${chalk.underline(relB)}${chalk.dim(`:${v.lineStartB}`)}`);
      console.log(`    Reason:   ${chalk.red(v.reason)}`);
      console.log(`    Proposed Fix:`);
      console.log(v.proposedFix.split('\n').map(line => `      ${line}`).join('\n'));
      console.log('');
    }
  }
}
