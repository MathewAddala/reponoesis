#!/usr/bin/env node
/**
 * Engine MCP Server
 *
 * Exposes 4 tools to AI agents:
 *
 *   engine_impact_map    — BEFORE making changes: what will be affected?
 *   engine_validate      — AFTER making changes: what chains are broken?
 *   engine_query         — Where does concept X live across the codebase?
 *   engine_acknowledge   — Acknowledge drift as intentional
 *
 * Works with Cursor, Claude Code, Gemini Code Assist, GitHub Copilot
 * via Model Context Protocol (stdio transport).
 *
 * Usage in Cursor / Claude Code mcp config:
 * {
 *   "engine": {
 *     "command": "engine-mcp",
 *     "args": ["--project", "/path/to/project"]
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
  process.stderr.write(`Engine not initialized at ${projectArg}. Run: engine init\n`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const indexer = new Indexer(config);

// ─── MCP Server Setup ──────────────────────────────────────────────────────────

const server = new Server(
  {
    name: 'engine',
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
      name: 'engine_impact_map',
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
      name: 'engine_validate',
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
      name: 'engine_query',
      description: `Search for all locations across the codebase where a specific concept lives.

Returns every file section that encodes the concept, with:
- File path and line range
- Chain state (VALID / CHAIN_BROKEN / ACKNOWLEDGED_DRIFT)
- Confidence level (STRUCTURAL / CONSENSUS / SINGLE_MODEL)

Use this to understand the full scope of a concept before modifying it.
Example: engine_query("ad_tracking") before removing ad SDK`,
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
      name: 'engine_acknowledge',
      description: `Acknowledge a broken chain as intentional drift (when you have reviewed and decided no update is needed).

This creates an immutable audit entry and moves the chain state from CHAIN_BROKEN to ACKNOWLEDGED_DRIFT.
Use when you have intentionally removed a concept and the referencing file correctly does not need updating.`,
      inputSchema: {
        type: 'object',
        properties: {
          concept_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Concept IDs to acknowledge (from engine_validate output)',
          },
          reason: {
            type: 'string',
            description: 'Human-readable reason for acknowledging the drift',
          },
        },
        required: ['concept_ids', 'reason'],
      },
    },
  ],
}));

// ─── Tool Handlers ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {

    case 'engine_impact_map': {
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

    case 'engine_validate': {
      const { changed_files } = z.object({ changed_files: z.array(z.string()) }).parse(args);

      // Re-index changed files
      await indexer.incrementalScan(changed_files as AbsPath[]);

      const brokenChains = indexer.getBrokenForFiles(changed_files as AbsPath[]);
      const health = indexer.getHealthSummary();

      const formatted = {
        status: brokenChains.length === 0 ? 'CLEAN' : 'CHAINS_BROKEN',
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
        overall_health: {
          total_concepts: health.totalConcepts,
          broken: health.brokenChains,
          valid: health.validChains,
        },
        recommendation: brokenChains.length > 0
          ? `Fix ${brokenChains.filter(b => b.severity === 'CRITICAL' || b.severity === 'HIGH').length} critical/high chain(s) before committing.`
          : 'All chains intact. Safe to commit.',
      };

      return { content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }] };
    }

    case 'engine_query': {
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

    case 'engine_acknowledge': {
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
process.stderr.write('Engine MCP server running (stdio)\n');
