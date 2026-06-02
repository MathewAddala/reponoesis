/**
 * `engine review` — Interactive broken chain resolution
 */
import chalk from 'chalk';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { Indexer } from '@engine/core';
import type { BrokenChainEntry } from '@engine/core';
import { select } from '@inquirer/prompts';

export async function reviewCommand(): Promise<void> {
  const cwd = process.cwd();

  if (!existsSync(resolve(cwd, '.engine', 'config.json'))) {
    console.error(chalk.red('[ERROR] Reponoesis not initialized. Run: rpn init'));
    process.exit(1);
  }

  const config = loadConfig(cwd);
  const indexer = new Indexer(config);
  const broken: BrokenChainEntry[] = indexer.getAllBrokenChains();

  if (broken.length === 0) {
    console.log('');
    console.log(chalk.green.bold('  [OK] No broken chains to review. All clear!'));
    console.log('');
    indexer.close();
    return;
  }

  console.log('');
  console.log(chalk.bold.cyan(`[RPN] Reponoesis — Interactive Review (${broken.length} broken chain(s))`));
  console.log('');

  for (const item of broken) {
    const rel = item.filePath.replace(cwd + '\\', '').replace(cwd + '/', '');

    console.log(chalk.red(`  [DRIFT] ${chalk.underline(rel)}:${item.lineStart}-${item.lineEnd}`));
    console.log(`    ${chalk.dim(`Concept: "${item.conceptLabel}"`)}`);
    console.log(`    ${chalk.dim(`Chain: ${item.chainLink.slice(0, 16) || '(pending)'}...`)}`);
    console.log(`    ${chalk.dim(`Reason: ${item.reason}`)}`);
    console.log('');

    const action = await select<'acknowledge' | 'resolve' | 'skip'>({
      message: 'What do you want to do?',
      choices: [
        { name: '[ACKNOWLEDGE] Mark as reviewed (acknowledge drift)', value: 'acknowledge' },
        { name: '[RESOLVE] Mark as resolved (I already fixed it)', value: 'resolve' },
        { name: '[SKIP] Skip for now', value: 'skip' },
      ],
    });

    if (action === 'acknowledge') {
      indexer.acknowledgeBrokenChain(item.conceptId, 'cli-review');
      console.log(chalk.yellow('  [ACK] Marked as acknowledged drift\n'));
    } else if (action === 'resolve') {
      indexer.resolveBrokenChain(item.conceptId);
      console.log(chalk.green('  [OK] Marked as resolved\n'));
    } else {
      console.log(chalk.dim('  Skipped\n'));
    }
  }

  indexer.close();
  console.log(chalk.bold('Review complete.'));
  console.log('');
}
