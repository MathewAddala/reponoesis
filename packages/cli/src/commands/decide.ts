/**
 * `rpn decide` — Record an Architecture Decision Record (ADR)
 */

import chalk from 'chalk';
import { input, select } from '@inquirer/prompts';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { GraphDB, hash, Indexer } from '@engine/core';
import type { AbsPath } from '@engine/core';

interface DecideOptions {
  propose?: boolean;
  title?: string;
  status?: string;
  body?: string;
  files?: string;   // comma-separated file paths for auto-bind
}

export async function decideCommand(label: string, options: DecideOptions): Promise<void> {
  const cwd = process.cwd();
  const configPath = resolve(cwd, '.engine', 'config.json');

  if (!existsSync(configPath)) {
    console.error(chalk.red('[ERROR] Reponoesis not initialized. Run: rpn init'));
    process.exit(1);
  }

  const config = loadConfig(cwd);
  const db = new GraphDB(config.dbPath);

  // Determine title programmatically or fall back to interactive prompt
  let title = options.title ? options.title.trim() : '';
  if (!title) {
    if (process.env.CI || process.env.NODE_ENV === 'test') {
      title = `Use ${label.replace(/_/g, ' ')}`;
    } else {
      console.log(chalk.bold.cyan('\n[RPN] Reponoesis — Propose/Record Architectural Decision'));
      console.log(chalk.dim(`   Creating decision entry for: "${label}"\n`));
      title = await input({
        message: 'Enter a short, descriptive title for the decision:',
        default: `Use ${label.replace(/_/g, ' ')}`,
        validate: (val) => val.trim().length > 5 || 'Title must be at least 5 characters.',
      });
    }
  }

  // Determine status programmatically or fall back to interactive prompt
  let status = options.status ? options.status.toUpperCase() : '';
  const initialStatus = options.propose ? 'PROPOSED' : 'ACCEPTED';
  if (!status) {
    if (process.env.CI || process.env.NODE_ENV === 'test') {
      status = initialStatus;
    } else {
      status = await select({
        message: 'Set decision status:',
        choices: [
          { name: 'PROPOSED — Under review and debate', value: 'PROPOSED' },
          { name: 'ACCEPTED — Approved for active codebase binding', value: 'ACCEPTED' },
          { name: 'SUPERSEDED — Superseded by another decision', value: 'SUPERSEDED' },
          { name: 'DEPRECATED — Deprecated and no longer active', value: 'DEPRECATED' },
        ],
        default: initialStatus as any,
      });
    }
  }

  let docBody = options.body ? options.body : '';

  // Use the programmatic body directly if provided, or fallback to the static skeleton
  if (!docBody) {
    docBody = `# ${title}

## Context
Provide background context on the problem, constraints, and technologies considered (e.g. why we chose GCP over AWS, or WAL mode over client-server DBs).

## Alternatives Considered
1. **[Alternative 1]**: Pros/Cons
2. **[Alternative 2]**: Pros/Cons

## Consequences
Detail what this decision means for the codebase and team workflow (positive/negative trade-offs).
`;
  }

  // 4. Save decision Markdown file to `.rpn/decisions/` folder
  const rpnDir = resolve(cwd, '.rpn');
  const decisionsDir = resolve(rpnDir, 'decisions');
  if (!existsSync(rpnDir)) mkdirSync(rpnDir);
  if (!existsSync(decisionsDir)) mkdirSync(decisionsDir);

  const markdownFilename = `${label.toLowerCase().replace(/[^a-z0-9_]/g, '_')}.md`;
  const markdownPath = resolve(decisionsDir, markdownFilename);
  writeFileSync(markdownPath, docBody, 'utf-8');

  // 5. Register decision into the SQLite Graph DB
  const now = Date.now();
  db.upsertDecision({
    id: hash(label),
    label,
    title,
    status: status as any,
    body: docBody,
    createdAt: now,
    updatedAt: now,
  });

  db.close();

  console.log(chalk.green.bold('\n[OK] Decision successfully registered in Reponoesis ledger!'));
  console.log(`[FILE] Rationale saved to:  ${chalk.underline(markdownPath.replace(cwd + '\\', '').replace(cwd + '/', ''))}`);

  // Auto-bind: if --files provided, bind the ADR to each file in one shot
  if (options.files) {
    const filePaths = options.files
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean)
      .map((f) => resolve(cwd, f) as AbsPath);

    if (filePaths.length > 0) {
      const indexer = new Indexer(config);
      const result = await indexer.recordAgentDecision({
        label,
        title,
        body: docBody,
        files: filePaths,
        status: status as 'PROPOSED' | 'ACCEPTED',
        projectRoot: cwd as AbsPath,
      });
      indexer.close();
      console.log(`[BIND] Auto-bound to ${chalk.bold.cyan(result.boundFiles)} file(s).`);
    }
  } else {
    console.log(`[LINK] To bind this decision to files, run: ${chalk.cyan(`rpn bind ${label} <path_to_file>`)}`);
    console.log(chalk.dim(`       Or use: rpn decide ${label} --files <path1,path2>  (auto-binds in one command)`));
  }
  console.log('');
}
