/**
 * `engine scan` — Full project index command
 */

import chalk from 'chalk';
import ora from 'ora';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { Indexer } from '@engine/core';

interface ScanOptions {
  verbose: boolean;
}

export async function scanCommand(options: ScanOptions): Promise<void> {
  const cwd = process.cwd();
  const configPath = resolve(cwd, '.engine', 'config.json');

  if (!existsSync(configPath)) {
    console.error(chalk.red('❌ Engine not initialized. Run: engine init'));
    process.exit(1);
  }

  const config = loadConfig(cwd);
  const indexer = new Indexer(config);

  console.log('');
  console.log(chalk.bold.cyan('⛓️  Engine — Full Project Scan'));
  console.log('');

  const spinner = ora('Starting scan...').start();

  await indexer.fullScan((msg) => {
    if (options.verbose) {
      spinner.text = msg;
    } else {
      spinner.text = msg;
    }
  });

  spinner.stop();

  const summary = indexer.getHealthSummary();
  indexer.close();

  console.log(chalk.green.bold(`  ✓ Scan complete`));
  console.log('');
  console.log(`  ${chalk.bold('Files indexed:')}   ${summary.totalFiles}`);
  console.log(`  ${chalk.bold('Concepts found:')}  ${summary.totalConcepts}`);
  console.log(`  ${chalk.bold('Edges created:')}   ${summary.totalEdges}`);
  console.log('');

  if (summary.brokenChains > 0) {
    console.log(chalk.red(`  ${summary.brokenChains} broken chain(s) detected!`));
    console.log(chalk.dim('  Run: engine review  — to inspect and resolve'));
  } else {
    console.log(chalk.green('  ✓ All chains intact'));
  }

  console.log('');
}
