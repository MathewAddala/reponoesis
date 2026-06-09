/**
 * `rpn bind` — Bind an architectural decision directly to a code/doc file
 */

import chalk from 'chalk';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { GraphDB, hash, buildChainLink, Indexer, AbsPath } from '@engine/core';

export async function bindCommand(decisionLabel: string, filePath: string): Promise<void> {
  const cwd = process.cwd();
  const configPath = resolve(cwd, '.engine', 'config.json');

  if (!existsSync(configPath)) {
    console.error(chalk.red('[ERROR] Reponoesis not initialized. Run: rpn init'));
    process.exit(1);
  }

  const config = loadConfig(cwd);
  const db = new GraphDB(config.dbPath);

  // 1. Verify decision exists
  const decisionId = hash(decisionLabel);
  const decision = db.getDecision(decisionId);

  if (!decision) {
    console.error(chalk.red(`\n[ERROR] Architectural decision "${decisionLabel}" not found.`));
    console.log(chalk.dim(`   Run: rpn decide ${decisionLabel}  — to create it first.\n`));
    db.close();
    process.exit(1);
  }

  // 2. Resolve absolute file path
  const absolutePath = resolve(cwd, filePath);
  if (!existsSync(absolutePath)) {
    console.error(chalk.red(`\n[ERROR] File "${filePath}" does not exist.`));
    db.close();
    process.exit(1);
  }

  // Auto-scan file before binding to ensure DB contains the latest file content hash
  const indexer = new Indexer(config);
  await indexer.incrementalScan([absolutePath as AbsPath]);
  indexer.close();

  // 3. Find file in Graph DB
  const file = db.getFileByPath(absolutePath as any);
  if (!file) {
    console.error(chalk.red(`\n[ERROR] File "${filePath}" has not been indexed yet.`));
    console.log(chalk.dim('   Please run: rpn scan  — to index the codebase first.\n'));
    db.close();
    process.exit(1);
  }

  // 4. Retrieve target sections (we bind to the file's primary enclosing section, i.e., index 0)
  const sections = db.getSectionsForFile(file.id);
  if (sections.length === 0) {
    console.error(chalk.red(`\n[ERROR] No parsable sections found in file "${filePath}".`));
    db.close();
    process.exit(1);
  }

  // 5. Build Merkle cryptographic binding chain links and insert decision link bridges in the DB for all sections
  for (const section of sections) {
    const chainLink = buildChainLink(decision.id, null, section.contentHash);
    db.insertDecisionLink({
      decisionId: decision.id,
      sectionId: section.id,
      fileId: file.id,
      chainLink,
      chainState: 'VALID',
    });
  }

  db.close();

  // Rebuild decision edges to ensure POLICY_GOVERNS relationships are updated
  const indexer2 = new Indexer(config);
  indexer2.rebuildDecisionEdges();
  indexer2.close();

  const relativeFile = filePath.replace(cwd + '\\', '').replace(cwd + '/', '');
  const firstSection = sections[0]!;
  const lastSection = sections[sections.length - 1]!;
  console.log(chalk.green.bold('\n[OK] Cryptographic Bridge established successfully!'));
  console.log(`[ADR]   Decision: ${chalk.bold.yellow(decision.label)} ("${decision.title}")`);
  console.log(`[BOUND] Bound to:  ${chalk.cyan(relativeFile)}${chalk.dim(` (lines ${firstSection.lineStart}-${lastSection.lineEnd})`)}`);
  console.log(chalk.dim('   Reponoesis will now actively verify this connection on every pre-commit check.\n'));
}
