/**
 * `rpn why` — Traces the architectural design rationale history of a file
 */

import chalk from 'chalk';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { GraphDB, hash } from '@engine/core';

export async function whyCommand(filePath: string): Promise<void> {
  const cwd = process.cwd();
  const configPath = resolve(cwd, '.engine', 'config.json');

  if (!existsSync(configPath)) {
    console.error(chalk.red('[ERROR] Reponoesis not initialized. Run: rpn init'));
    process.exit(1);
  }

  const config = loadConfig(cwd);
  const db = new GraphDB(config.dbPath);

  const absolutePath = resolve(cwd, filePath);
  if (!existsSync(absolutePath)) {
    console.error(chalk.red(`[ERROR] Error: File "${filePath}" does not exist.`));
    db.close();
    process.exit(1);
  }

  // 1. Fetch File and Sections
  const file = db.getFileByPath(absolutePath as any);
  if (!file) {
    console.error(chalk.red(`[ERROR] Error: File "${filePath}" has not been scanned yet. Please run: rpn scan`));
    db.close();
    process.exit(1);
  }

  const relativeFile = filePath.replace(cwd + '\\', '').replace(cwd + '/', '');

  console.log(chalk.bold.cyan(`\n[RPN] Reponoesis Oracle — Cognitive Rationale for: "${relativeFile}"`));
  console.log(chalk.dim('   Tracing design rationale ledger, trade-off history, and invariants...\n'));

  // 2. Fetch Bound Decisions (The Bridge!)
  const links = db.getDecisionLinksForFile(file.id);

  if (links.length === 0) {
    console.log(chalk.yellow(`  [WARN] No explicit architectural decisions bound to: "${relativeFile}"`));
    console.log(chalk.dim(`    To link a design decision to this file, run: rpn bind <decision_label> ${relativeFile}\n`));
  } else {
    console.log(chalk.bold.blue(`  [ADR] Governing Decisions Ledger (${links.length} active):`));
    for (const link of links) {
      const decision = db.getDecision(link.decisionId);
      if (!decision) continue;

      const statusColor = 
        decision.status === 'ACCEPTED' ? chalk.green.bold :
        decision.status === 'PROPOSED' ? chalk.yellow :
        chalk.red;

      console.log(`\n  • ${chalk.bold.yellow(decision.label)} — "${decision.title}"`);
      console.log(`    Status:      [${statusColor(decision.status)}]`);
      console.log(`    Binding:     ${link.chainState === 'VALID' ? chalk.green('[BOUND] Cryptographically Intact') : chalk.red.bold('[CRITICAL] DRIFT DETECTED — Code section altered')}`);
      console.log(`    Recorded:    ${new Date(decision.createdAt).toLocaleDateString()}`);
      console.log(chalk.dim('\n    Rationale & Context:'));
      
      // Indent markdown body for clean CLI printing
      const indentedBody = decision.body
        .split('\n')
        .map(line => `      ${line}`)
        .join('\n');
      console.log(indentedBody);
      console.log(chalk.dim('    ────────────────────────────────────────────────────'));
    }
  }

  // 3. Fetch AST Concepts and Structural Invariants inside the file
  const sections = db.getSectionsForFile(file.id);
  const fileConcepts = new Set<string>();
  for (const s of sections) {
    const concepts = db.getConceptsForSection(s.id);
    for (const c of concepts) {
      fileConcepts.add(c.label);
    }
  }

  if (fileConcepts.size > 0) {
    console.log(chalk.bold.blue('\n  [CONCEPT] Associated Semantic Concepts & Invariants:'));
    for (const label of fileConcepts) {
      const locations = db.getConceptLocations(label);
      // Exclude self from other files count
      const normAbsolutePath = absolutePath.replace(/\\/g, '/');
      const otherFiles = new Set(locations.map(l => l.filePath).filter(p => p !== normAbsolutePath));
      console.log(`    • ${chalk.bold.magenta(label)}`);
      if (otherFiles.size > 0) {
        console.log(`      └─ Semantically linked to ${chalk.cyan(otherFiles.size)} other file(s):`);
        for (const other of otherFiles) {
          const relOther = other.replace(cwd + '\\', '').replace(cwd + '/', '');
          console.log(`         - ${chalk.dim(relOther)}`);
        }
      } else {
        console.log(chalk.dim('      └─ Isolated to this file.'));
      }
    }
  }

  db.close();
  console.log('');
}
