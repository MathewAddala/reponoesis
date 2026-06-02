/**
 * `engine query <concept>` — Find concept across codebase
 */
import chalk from 'chalk';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { Indexer } from '@engine/core';

export async function queryCommand(concept: string): Promise<void> {
  const cwd = process.cwd();

  if (!existsSync(resolve(cwd, '.engine', 'config.json'))) {
    console.error(chalk.red('[ERROR] Reponoesis not initialized. Run: rpn init'));
    process.exit(1);
  }

  const config = loadConfig(cwd);
  const indexer = new Indexer(config);
  const locations = indexer.queryConceptLocations(concept);
  indexer.close();

  console.log('');
  console.log(chalk.bold.cyan(`[RPN] Concept: "${concept}"`));

  if (locations.length === 0) {
    console.log(chalk.dim(`  No locations found. Try: rpn scan first.`));
    console.log('');
    return;
  }

  console.log(chalk.dim(`  Found in ${locations.length} location(s):\n`));

  for (const loc of locations) {
    const rel = loc.filePath.replace(cwd + '/', '');
    const stateColor = loc.chainState === 'VALID' ? chalk.green : loc.chainState === 'CHAIN_BROKEN' ? chalk.red : chalk.yellow;
    const stateIcon = loc.chainState === 'VALID' ? '[OK]' : loc.chainState === 'CHAIN_BROKEN' ? '[DRIFT]' : '[ACK]';

    console.log(`  ${stateColor(stateIcon)} ${chalk.underline(rel)}${chalk.dim(`:${loc.lineStart}-${loc.lineEnd}`)}`);
    console.log(`    ${chalk.dim(`Chain: ${loc.chainState} | Confidence: ${loc.confidence}`)}`);
  }
  console.log('');
}
