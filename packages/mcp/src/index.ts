#!/usr/bin/env node
/**
 * Reponoesis MCP Server
 *
 * Exposes 7 tools to AI agents:
 *
 *   rpn_get_context      — SESSION START: load full project context & WHY decisions
 *   rpn_impact_map       — BEFORE making changes: what will be affected?
 *   rpn_validate         — AFTER making changes: what chains are broken?
 *   rpn_record_concept   — YOU record what code means (agent is the brain)
 *   rpn_record_decision  — YOU create ADR + auto-bind (preserve the WHY)
 *   rpn_query            — Where does concept X live across the codebase?
 *   rpn_acknowledge      — Acknowledge drift as intentional
 *
 * Works with Cursor, Claude Code, Gemini Code Assist, GitHub Copilot
 * via Model Context Protocol (stdio transport).
 *
 * Usage in mcp config (Cursor / Claude Code / Gemini):
 * {
 *   "rpn": {
 *     "command": "rpn-mcp",
 *     "args": ["--project", "/abs/path/to/your/project"]
 *   }
 * }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Indexer } from '@engine/core';
import type { AbsPath, Hash } from '@engine/core';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Args ──────────────────────────────────────────────────────────────────────

const projectArg = process.argv.find((_, i, arr) => arr[i - 1] === '--project') ?? process.cwd();
const configPath = resolve(projectArg, '.engine', 'config.json');

if (!existsSync(configPath)) {
  process.stderr.write(`Reponoesis not initialized at ${projectArg}. Run: rpn init\n`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const indexer = new Indexer(config);

// ─── MCP Server Setup ──────────────────────────────────────────────────────────

const server = new Server(
  {
    name: 'rpn',
    version: '0.1.0',
  },
  {
    capabilities: { tools: {} },
  },
);

// ─── Tool Definitions ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'rpn_impact_map',
      description: `[Call BEFORE making changes] Returns a complete map of what will be semantically impacted if you modify the specified files.

Shows:
- Direct syntactic dependencies (imports, calls) — CRITICAL severity
- Cross-file business rule instances — HIGH severity  
- Policy/legal files that govern the changed concepts — HIGH severity
- Files sharing semantic concepts — MEDIUM severity

Use this BEFORE editing any file to understand the full blast radius.
Always update ALL impacted files in the same session to maintain chain integrity.`,
      inputSchema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute paths to files you plan to modify',
          },
        },
        required: ['files'],
      },
    },

    {
      name: 'rpn_validate',
      description: `[Call AFTER making changes] Validates that all semantic dependency chains are intact after your edits.

Returns:
- Broken chains: files that became stale as a result of your changes
- Chain link hashes: cryptographic proof of which links broke
- Suggested next steps for each broken chain

Always call this after completing a set of related changes to ensure zero semantic drift.`,
      inputSchema: {
        type: 'object',
        properties: {
          changed_files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute paths to files you modified',
          },
        },
        required: ['changed_files'],
      },
    },

    {
      name: 'rpn_query',
      description: `Search for all locations across the codebase where a specific concept lives.

Returns every file section that encodes the concept, with:
- File path and line range
- Chain state (VALID / CHAIN_BROKEN / ACKNOWLEDGED_DRIFT)
- Confidence level (STRUCTURAL / CONSENSUS / SINGLE_MODEL)

Use this to understand the full scope of a concept before modifying it.
Example: rpn_query("ad_tracking") before removing ad SDK`,
      inputSchema: {
        type: 'object',
        properties: {
          concept: {
            type: 'string',
            description: 'Concept label to search for (snake_case preferred)',
          },
        },
        required: ['concept'],
      },
    },

    {
      name: 'rpn_acknowledge',
      description: `Acknowledge a broken chain as intentional drift (when you have reviewed and decided no update is needed).

This creates an immutable audit entry and moves the chain state from CHAIN_BROKEN to ACKNOWLEDGED_DRIFT.
Use when you have intentionally removed a concept and the referencing file correctly does not need updating.`,
      inputSchema: {
        type: 'object',
        properties: {
          concept_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Concept IDs to acknowledge (from rpn_validate output)',
          },
          reason: {
            type: 'string',
            description: 'Human-readable reason for acknowledging the drift',
          },
        },
        required: ['concept_ids', 'reason'],
      },
    },

    {
      name: 'rpn_get_context',
      description: `[Call at SESSION START] Load the full project architectural context into your working memory.

Returns:
- All active ADR decisions with full WHY rationale (why we chose X over Y)
- Which files each decision governs
- Concept map: what semantic concepts are tracked and where they live
- Recent audit events (what changed, who changed it)
- Chain health summary
- A compact briefing string you can use as context

ALWAYS call this first at the start of every new agent session to prevent amnesia.
This is your "getting oriented" tool — know the project before touching anything.`,
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },

    {
      name: 'rpn_record_concept',
      description: `[YOU are the brain] Record a semantic concept that YOU have identified in the code.

Reponoesis does NOT extract concepts automatically — YOU are the extractor.
When you read code and understand what it means semantically, call this tool to
write that understanding into the Merkle graph. This creates a cryptographic anchor
that will alert future agents if this code changes without documentation.

Use snake_case labels. Be specific.
Examples:
  - "billing_model" for pricing/fee logic
  - "auth_strategy" for authentication approach
  - "data_retention_policy" for GDPR/retention rules
  - "rate_limiting" for API rate limit logic

The concept will be automatically linked (CONCEPT_SHARED edge) to all other sections
that already carry the same label.`,
      inputSchema: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: 'Absolute path to the file containing the concept',
          },
          label: {
            type: 'string',
            description: 'snake_case concept label, e.g. "billing_model"',
          },
          description: {
            type: 'string',
            description: 'What YOU understand this code to mean semantically',
          },
          confidence: {
            type: 'string',
            enum: ['CONSENSUS', 'SINGLE_MODEL'],
            description: 'CONSENSUS = you are certain; SINGLE_MODEL = you think so but not fully confident',
          },
          line_start: {
            type: 'number',
            description: 'Optional: first line of the relevant code section',
          },
          line_end: {
            type: 'number',
            description: 'Optional: last line of the relevant code section',
          },
        },
        required: ['file', 'label', 'description', 'confidence'],
      },
    },

    {
      name: 'rpn_record_decision',
      description: `[YOU are the brain] Create an Architecture Decision Record (ADR) from your own analysis.

Call this when the developer makes a significant decision and you want to preserve
the WHY for future agents — "why we chose Postgres over MongoDB", "why $10 not $50",
"why we use JWT not sessions".

This AUTOMATICALLY binds the decision to all listed files in one call.
No separate rpn bind command needed.

The body should capture:
- What was decided
- WHY (tradeoffs you considered, alternatives you rejected)
- What this means for the codebase going forward

After calling this, run rpn_validate to confirm all chains are clean.`,
      inputSchema: {
        type: 'object',
        properties: {
          label: {
            type: 'string',
            description: 'snake_case decision identifier, e.g. "billing_model_v2"',
          },
          title: {
            type: 'string',
            description: 'Short human-readable title, e.g. "Change flat fee from $50 to $10"',
          },
          body: {
            type: 'string',
            description: 'Markdown body explaining WHY this decision was made',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute paths to files this decision governs (all will be auto-bound)',
          },
          status: {
            type: 'string',
            enum: ['PROPOSED', 'ACCEPTED'],
            description: 'ACCEPTED = live decision; PROPOSED = under discussion',
          },
        },
        required: ['label', 'title', 'body', 'files', 'status'],
      },
    },
    {
      name: 'rpn_record_violation',
      description: `[YOU are the brain] Record a semantic logic contradiction or drift that YOU have identified between two files.

Reponoesis does not run background headless checks — you represent the AI Brain and are responsible for logic auditing. When you identify that two files have contradictory rules, logic, pricing, or constant values under a shared concept, call this tool to write that contradiction into the Graph DB. This will immediately display on the visual PCB board and block commits at pre-commit checks.

Be specific in the explanation ('reason') of what caused what, and supply a clear 'proposed_fix' snippet.`,
      inputSchema: {
        type: 'object',
        properties: {
          concept_label: {
            type: 'string',
            description: 'snake_case concept under which this violation falls, e.g. "retry_policy"',
          },
          file_a: {
            type: 'string',
            description: 'Absolute path to the first conflicting file (e.g. source of truth)',
          },
          line_start_a: {
            type: 'number',
            description: 'Approximate line number in File A where the concept resides',
          },
          file_b: {
            type: 'string',
            description: 'Absolute path to the second conflicting file (the violating file)',
          },
          line_start_b: {
            type: 'number',
            description: 'Approximate line number in File B where the contradiction resides',
          },
          reason: {
            type: 'string',
            description: 'Detailed explanation of what caused what and why they contradict',
          },
          proposed_fix: {
            type: 'string',
            description: 'Proposed code fix or patch explanation to resolve it',
          },
          severity: {
            type: 'string',
            enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
            description: 'Severity of this contradiction (defaults to \'HIGH\')',
          },
        },
        required: ['concept_label', 'file_a', 'line_start_a', 'file_b', 'line_start_b', 'reason', 'proposed_fix'],
      },
    },
    {
      name: 'rpn_record_drift_explanation',
      description: `[YOU are the brain] Record an AI-explained drift description for a broken decision link or concept.

Since you are the AI Brain, you should analyze why a Merkle chain broke (what semantic drift occurred in plain English) and call this tool to write that explanation back to the local database. The visualizer UI will display this explanation directly under the "Why it's broken" section, replacing the default cryptographic message.`,
      inputSchema: {
        type: 'object',
        properties: {
          concept_id: {
            type: 'string',
            description: 'Concept ID or Decision ID whose chain is broken (from rpn_validate output)',
          },
          section_id: {
            type: 'string',
            description: 'Optional: Section ID of the broken link (if multiple sections are bound to the same decision/concept)',
          },
          explanation: {
            type: 'string',
            description: 'Your plain English explanation of the semantic drift that occurred',
          },
        },
        required: ['concept_id', 'explanation'],
      },
    },
  ],
}));

// ─── Tool Handlers ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {

    case 'rpn_impact_map': {
      const { files } = z.object({ files: z.array(z.string()) }).parse(args);

      // Incremental re-index the files to be changed
      await indexer.incrementalScan(files as AbsPath[]);

      const impact = indexer.getImpactMap(files as AbsPath[]);

      const formatted = {
        summary: `${impact.total} file section(s) will be impacted by changes to ${files.length} file(s).`,
        changed_files: impact.changedFiles,
        impacted_sections: impact.impacted?.map(i => ({
          file: i.filePath,
          lines: `${i.lineStart}-${i.lineEnd}`,
          severity: i.edgeType === 'SYNTACTIC_IMPORT' || i.edgeType === 'DATA_FLOW' ? 'CRITICAL' : 'MEDIUM',
          edge_type: i.edgeType,
          depth: i.depth,
        })),
        already_broken_chains: impact.brokenChains?.length ?? 0,
        recommendation: impact.total > 0
          ? `Update all ${impact.total} impacted section(s) in the same session to maintain chain integrity.`
          : 'No semantic dependencies will be broken by these changes.',
      };

      return { content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }] };
    }

    case 'rpn_validate': {
      const { changed_files } = z.object({ changed_files: z.array(z.string()) }).parse(args);

      // Re-index changed files
      await indexer.incrementalScan(changed_files as AbsPath[]);

      const brokenChains = indexer.getBrokenForFiles(changed_files as AbsPath[]);
      const health = indexer.getHealthSummary();
      const suggestions = await indexer.getSuggestionsForFiles(changed_files as AbsPath[]);
      const semanticViolations = indexer.getSemanticViolationsWithDetails();

      const formatted = {
        status: (brokenChains.length === 0 && suggestions.length === 0 && semanticViolations.length === 0) ? 'CLEAN' : 'CHAINS_BROKEN',
        broken_chains: brokenChains.map(b => ({
          file: b.filePath,
          lines: `${b.lineStart}-${b.lineEnd}`,
          concept: b.conceptLabel,
          severity: b.severity,
          chain_link: b.chainLink ? b.chainLink.slice(0, 16) + '...' : '(pending)',
          action_required: b.severity === 'CRITICAL' || b.severity === 'HIGH'
            ? 'Update this file to reflect the upstream change'
            : 'Review this file — may need updating',
        })),
        semantic_violations: semanticViolations.map(v => ({
          id: v.id,
          concept_label: v.conceptLabel,
          file_a: v.fileAPath,
          line_start_a: v.lineStartA,
          file_b: v.fileBPath,
          line_start_b: v.lineStartB,
          reason: v.reason,
          proposed_fix: v.proposedFix,
          severity: v.severity,
          action_required: 'Fix the logical inconsistency or coordinate with the developer to reconcile rules.',
        })),
        suggestions: suggestions.map(s => ({
          file: s.filePath,
          lines: s.lines,
          concept: s.concept,
          reason: s.reason,
          suggested_command: s.suggestedCommand,
          bind_command: s.bindCommand,
          action_required: 'Run the suggested decide and bind commands to register an ADR for this mutation.'
        })),
        overall_health: {
          total_concepts: health.totalConcepts,
          broken: health.brokenChains,
          valid: health.validChains,
          semantic_violations: semanticViolations.length,
        },
        recommendation: semanticViolations.length > 0
          ? `Detected ${semanticViolations.length} logic contradiction(s). Fix contradictions or adjust files to align rules.`
          : suggestions.length > 0
            ? `Undocumented constant mutations detected. Run suggested decide/bind commands to document them.`
            : brokenChains.length > 0
              ? `Fix ${brokenChains.filter(b => b.severity === 'CRITICAL' || b.severity === 'HIGH').length} critical/high chain(s) before committing.`
              : 'All chains intact. Safe to commit.',
      };

      return { content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }] };
    }

    case 'rpn_query': {
      const { concept } = z.object({ concept: z.string() }).parse(args);
      const locations = indexer.queryConceptLocations(concept);

      const formatted = {
        concept,
        found_in: locations.length,
        locations: locations.map(l => ({
          file: l.filePath,
          lines: `${l.lineStart}-${l.lineEnd}`,
          chain_state: l.chainState,
          confidence: l.confidence,
        })),
        recommendation: locations.length > 1
          ? `This concept lives in ${locations.length} locations. Changing any one of them should trigger updates in the others.`
          : locations.length === 1
            ? `This concept is defined in one place. Safe to modify without cross-file impact.`
            : `Concept "${concept}" not found in the index. Run: engine scan to rebuild the index.`,
      };

      return { content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }] };
    }

    case 'rpn_acknowledge': {
      const { concept_ids, reason } = z.object({
        concept_ids: z.array(z.string()),
        reason: z.string(),
      }).parse(args);

      let acknowledged = 0;
      for (const conceptId of concept_ids) {
        indexer.acknowledgeBrokenChain(conceptId as Hash, `mcp:${reason}`);
        acknowledged++;
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            acknowledged,
            reason,
            status: 'ACKNOWLEDGED_DRIFT',
            note: 'Audit entry created. Chain states updated to ACKNOWLEDGED_DRIFT.',
          }, null, 2),
        }],
      };
    }

    case 'rpn_get_context': {
      const context = indexer.getFullContext();
      const semanticViolations = indexer.getSemanticViolationsWithDetails();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            briefing: context.briefing,
            decisions: context.decisions,
            concept_map: context.conceptMap,
            recent_events: context.recentEvents,
            health: context.health,
            semantic_violations: semanticViolations.map(v => ({
              id: v.id,
              concept_label: v.conceptLabel,
              file_a: v.fileAPath,
              line_start_a: v.lineStartA,
              file_b: v.fileBPath,
              line_start_b: v.lineStartB,
              reason: v.reason,
              proposed_fix: v.proposedFix,
              severity: v.severity,
            })),
            instructions: [
              'Use rpn_impact_map BEFORE editing files',
              'Use rpn_validate AFTER editing files',
              'Use rpn_record_concept to record what you understand code to mean',
              'Use rpn_record_decision to create an ADR for WHY a decision was made (auto-binds to files)',
              'Use rpn_record_violation to write a semantic logic contradiction back to the local database',
            ],
          }, null, 2),
        }],
      };
    }

    case 'rpn_record_concept': {
      const parsed = z.object({
        file: z.string(),
        label: z.string(),
        description: z.string(),
        confidence: z.enum(['CONSENSUS', 'SINGLE_MODEL']),
        line_start: z.number().optional(),
        line_end: z.number().optional(),
      }).parse(args);

      const result = await indexer.recordAgentConcept({
        filePath: parsed.file as AbsPath,
        label: parsed.label,
        description: parsed.description,
        confidence: parsed.confidence,
        lineStart: parsed.line_start,
        lineEnd: parsed.line_end,
      });

      if (!result) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'ERROR',
              message: `File "${parsed.file}" could not be indexed. Check the path is correct and the file exists.`,
            }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'RECORDED',
            concept_id: result.conceptId,
            section_id: result.sectionId,
            label: parsed.label,
            edges_created: result.edgesCreated,
            message: `Concept "${parsed.label}" recorded and Merkle-anchored. ${result.edgesCreated} CONCEPT_SHARED edges created to related sections.`,
            next_step: result.edgesCreated > 0
              ? `This concept now links ${result.edgesCreated / 2 + 1} files. If you change any of them, Reponoesis will detect the drift.`
              : 'First time this concept was recorded. Future changes to this section will be detected.',
          }, null, 2),
        }],
      };
    }

    case 'rpn_record_decision': {
      const parsed = z.object({
        label: z.string(),
        title: z.string(),
        body: z.string(),
        files: z.array(z.string()),
        status: z.enum(['PROPOSED', 'ACCEPTED']),
      }).parse(args);

      const result = await indexer.recordAgentDecision({
        label: parsed.label,
        title: parsed.title,
        body: parsed.body,
        files: parsed.files as AbsPath[],
        status: parsed.status,
        projectRoot: projectArg as AbsPath,
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'RECORDED',
            decision_id: result.decisionId,
            label: parsed.label,
            bound_files: result.boundFiles,
            markdown_path: result.markdownPath,
            message: `ADR "${parsed.label}" created and auto-bound to ${result.boundFiles} file(s). No separate bind command needed.`,
            next_step: 'Call rpn_validate with the modified files to confirm all chains are clean.',
          }, null, 2),
        }],
      };
    }

    case 'rpn_record_violation': {
      const parsed = z.object({
        concept_label: z.string(),
        file_a: z.string(),
        line_start_a: z.number(),
        file_b: z.string(),
        line_start_b: z.number(),
        reason: z.string(),
        proposed_fix: z.string(),
        severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional(),
      }).parse(args);

      const result = await indexer.recordAgentViolation({
        conceptLabel: parsed.concept_label,
        fileA: parsed.file_a as AbsPath,
        lineStartA: parsed.line_start_a,
        fileB: parsed.file_b as AbsPath,
        lineStartB: parsed.line_start_b,
        reason: parsed.reason,
        proposedFix: parsed.proposed_fix,
        severity: parsed.severity,
      });

      if (!result) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'ERROR',
              message: 'Failed to record violation. Verify paths exist and lines are valid.',
            }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'RECORDED',
            violation_id: result.violationId,
            concept_label: parsed.concept_label,
            message: `Semantic contradiction recorded successfully in the local database. Trace link drawn.`,
            next_step: 'Run rpn check or view UI to inspect the contradiction warning.',
          }, null, 2),
        }],
      };
    }

    case 'rpn_record_drift_explanation': {
      const parsed = z.object({
        concept_id: z.string(),
        section_id: z.string().optional(),
        explanation: z.string(),
      }).parse(args);

      indexer.recordDriftExplanation(parsed.concept_id as Hash, (parsed.section_id as Hash) ?? null, parsed.explanation);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'RECORDED',
            concept_id: parsed.concept_id,
            message: 'Custom drift explanation recorded successfully.',
          }, null, 2),
        }],
      };
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
});

// ─── Cleanup ───────────────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  indexer.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  indexer.close();
  process.exit(0);
});

// ─── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('Reponoesis MCP server running (stdio)\n');
