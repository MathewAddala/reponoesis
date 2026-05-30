/**
 * `engine init` — Project initialization
 *
 * Creates:
 *   .engine/config.json    — project configuration
 *   .engine/graph.db       — SQLite graph (empty, created by first scan)
 *   .engine/.gitignore     — ignore the DB file
 *   .git/hooks/pre-commit  — git hook that calls `engine check`
 */

import chalk from 'chalk';
import ora from 'ora';
import { resolve, join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, chmodSync, readFileSync } from 'node:fs';
import type { EngineConfig, AbsPath } from '@engine/core';

interface InitOptions {
  hook: boolean;
  geminiKey?: string;
  localModel?: string;
}

const DEFAULT_CONFIG = (projectRoot: string, geminiKey: string | null, localModel: string): EngineConfig => ({
  projectRoot: projectRoot as AbsPath,
  dbPath: join(projectRoot, '.engine', 'graph.db') as AbsPath,
  ignorePaths: [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/.engine/**',
    '**/*.min.js',
    '**/*.map',
  ],
  enabledParsers: ['typescript', 'javascript', 'python', 'json', 'yaml', 'markdown', 'env', 'text'],
  ai: {
    primaryModel: 'gemini-2.0-flash',
    localModel: localModel as 'mistral' | 'llama3' | 'none',
    geminiApiKey: geminiKey,
    consensusRequired: false,  // single model ok if other unavailable
    embeddingModel: 'text-embedding-004',
  },
  gatekeeper: {
    blockOnCritical: true,
    blockOnHigh: false,
    warnOnMedium: true,
    maxDepth: 8,
  },
});

const PRE_COMMIT_HOOK = `#!/bin/sh
# Engine — Semantic chain integrity check
# Installed by: engine init

engine check
exit $?
`;

export async function initCommand(options: InitOptions): Promise<void> {
  const cwd = process.cwd();
  const engineDir = resolve(cwd, '.engine');
  const configPath = resolve(engineDir, 'config.json');

  console.log('');
  console.log(chalk.bold.cyan('⛓️  Engine — Project Initialization'));
  console.log('');

  // Already initialized?
  if (existsSync(configPath)) {
    console.log(chalk.yellow('  Already initialized. Updating config...\n'));
  }

  const spinner = ora('Setting up engine directory...').start();

  // Create .engine/ directory
  mkdirSync(engineDir, { recursive: true });

  // .engine/.gitignore — don't commit the graph DB
  writeFileSync(
    resolve(engineDir, '.gitignore'),
    '# Engine graph database (local only)\ngraph.db\ngraph.db-shm\ngraph.db-wal\n',
    'utf8',
  );

  spinner.succeed('Engine directory created');

  // Write config
  const config = DEFAULT_CONFIG(
    cwd,
    options.geminiKey ?? process.env['GEMINI_API_KEY'] ?? null,
    options.localModel ?? 'mistral',
  );
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  spinner.succeed(`Config written to ${chalk.underline('.engine/config.json')}`);

  // Install pre-commit hook
  if (options.hook) {
    const gitDir = resolve(cwd, '.git');
    if (!existsSync(gitDir)) {
      console.log(chalk.yellow('  ⚠ No .git directory found — skipping pre-commit hook'));
    } else {
      const hookPath = resolve(gitDir, 'hooks', 'pre-commit');
      mkdirSync(resolve(gitDir, 'hooks'), { recursive: true });

      // Append if hook already exists, otherwise create
      if (existsSync(hookPath)) {
        const existing = readFileSync(hookPath, 'utf8');
        if (!existing.includes('engine check')) {
          writeFileSync(hookPath, existing + '\n' + PRE_COMMIT_HOOK, 'utf8');
        }
      } else {
        writeFileSync(hookPath, PRE_COMMIT_HOOK, 'utf8');
      }

      try {
        chmodSync(hookPath, 0o755);
        ora().succeed(`Pre-commit hook installed at ${chalk.underline('.git/hooks/pre-commit')}`);
      } catch {
        console.log(chalk.yellow('  ⚠ Could not chmod hook — you may need to run: chmod +x .git/hooks/pre-commit'));
      }
    }
  }

  console.log('');
  console.log(chalk.green.bold('  ✓ Engine initialized successfully!'));
  console.log('');
  console.log(chalk.dim('  Next steps:'));
  console.log(chalk.dim('    1. engine scan          — index your project'));
  console.log(chalk.dim('    2. engine status         — view chain health'));
  console.log(chalk.dim('    3. engine check          — run on any git diff'));
  console.log('');

  if (!config.ai.geminiApiKey) {
    console.log(chalk.yellow('  ⚠ No Gemini API key found.'));
    console.log(chalk.dim('    AI concept extraction will be disabled.'));
    console.log(chalk.dim('    Set GEMINI_API_KEY or run: engine init --gemini-key YOUR_KEY'));
    console.log('');
  }
}
