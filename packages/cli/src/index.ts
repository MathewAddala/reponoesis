#!/usr/bin/env node
/**
 * Reponoesis CLI Entry Point
 *
 * Commands:
 *   init     — Initialize Reponoesis in current project
 *   scan     — Full project index
 *   check    — Check current git diff for broken chains
 *   review   — Interactive broken chain review
 *   status   — Show chain health dashboard
 *   query    — Search for a concept across the codebase
 *   decide   — Record a new ADR decision
 *   bind     — Establish Merkle bridge from decision to code
 *   pack     — Compile token-optimized context handover file
 *   unpack   — Hydrate cognitive graph from handover file
 *   why      — Trace and explain the architectural rationale of a file
 *   ui       — Start the visualizer server
 */

import { program } from 'commander';
import { initCommand } from './commands/init.js';
import { scanCommand } from './commands/scan.js';
import { checkCommand } from './commands/check.js';
import { statusCommand } from './commands/status.js';
import { queryCommand } from './commands/query.js';
import { reviewCommand } from './commands/review.js';
import { uiCommand } from './commands/ui.js';
import { decideCommand } from './commands/decide.js';
import { bindCommand } from './commands/bind.js';
import { packCommand, unpackCommand } from './commands/pack.js';
import { whyCommand } from './commands/why.js';

const VERSION = '0.1.0';

program
  .name('rpn')
  .description('Reponoesis — cryptographic change propagation and AI knowledge handover for agentic codebases')
  .version(VERSION);

program
  .command('init')
  .description('Initialize Reponoesis in this project (creates .engine/ config + git hook)')
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

program
  .command('decide <label>')
  .description('Record an Architecture Decision Record (ADR) with optional AI-assisted tradeoff reasoning')
  .option('--propose', 'Record decision status as PROPOSED instead of ACCEPTED')
  .option('--title <title>', 'Programmatic title for the decision (skips interactive prompt)')
  .option('--status <status>', 'Programmatic status (PROPOSED|ACCEPTED|SUPERSEDED|DEPRECATED)')
  .option('--body <body>', 'Programmatic body markdown content for the decision (skips interactive prompt)')
  .option('--files <paths>', 'Comma-separated file paths to auto-bind this decision to (no separate rpn bind needed)')
  .action(decideCommand);

program
  .command('bind <decision_label> <filePath>')
  .description('Establish a Merkle cryptographic bridge linking an ADR to a specific code file section')
  .action(bindCommand);

program
  .command('pack')
  .description('Package the cognitive graph and ADR states into a token-optimized JSON handover file')
  .option('-o, --output <filename>', 'Handover output filename (default: rpn_handover.json)')
  .action(packCommand);

program
  .command('unpack <packet>')
  .description('Unpack a knowledge handover file and hydrate/restore the local graph state')
  .action(unpackCommand);

program
  .command('why <filePath>')
  .description('Trace and explain the cognitive rationale and architectural trade-offs governing a file')
  .action(whyCommand);

program
  .command('ui')
  .description('Start the Circuit Board UI local web server and open in browser')
  .option('-p, --port <port>', 'Port to listen on (default: 3000)', '3000')
  .option('-h, --host <host>', 'Host to listen on (default: localhost)', 'localhost')
  .action(uiCommand);

program.parse(process.argv);

