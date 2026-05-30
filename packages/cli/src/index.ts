#!/usr/bin/env node
/**
 * CLI Entry Point
 *
 * Commands:
 *   init     — Initialize engine in current project
 *   scan     — Full project index
 *   check    — Check current git diff for broken chains
 *   review   — Interactive broken chain review
 *   status   — Show chain health dashboard
 *   query    — Search for a concept across the codebase
 */

import { program } from 'commander';
import { initCommand } from './commands/init.js';
import { scanCommand } from './commands/scan.js';
import { checkCommand } from './commands/check.js';
import { statusCommand } from './commands/status.js';
import { queryCommand } from './commands/query.js';
import { reviewCommand } from './commands/review.js';

const VERSION = '0.1.0';

program
  .name('engine')
  .description('Semantic dependency engine — cryptographic change propagation for AI-native codebases')
  .version(VERSION);

program
  .command('init')
  .description('Initialize the engine in this project (creates .engine/ config + git hook)')
  .option('--no-hook', 'Skip installing the pre-commit git hook')
  .option('--gemini-key <key>', 'Gemini API key for AI concept extraction')
  .option('--local-model <model>', 'Local Ollama model name (default: mistral)')
  .action(initCommand);

program
  .command('scan')
  .description('Full project scan — index all files and build dependency graph')
  .option('--verbose', 'Show detailed progress')
  .action(scanCommand);

program
  .command('check')
  .description('Check current git diff for semantic chain breaks (used by pre-commit hook)')
  .option('--json', 'Output results as JSON')
  .option('--fail-on <level>', 'Exit code 1 if severity >= level (critical|high|medium)', 'critical')
  .action(checkCommand);

program
  .command('status')
  .description('Show chain health dashboard for current project')
  .option('--broken', 'Show only broken chains')
  .action(statusCommand);

program
  .command('query <concept>')
  .description('Find all locations where a concept lives across the codebase')
  .action(queryCommand);

program
  .command('review')
  .description('Interactive review of broken chains — acknowledge or open files')
  .action(reviewCommand);

program.parse(process.argv);
