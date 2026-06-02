/**
 * File Parser & Chunker — Wholly Agent-Brain Governed
 *
 * All automatic deterministic AST parsers (Babel, Remark, etc.) have been completely
 * removed to align with a pure Agent-Brain framework.
 *
 * Each file is treated wholly as a single unified section, allowing the active AI Agent
 * to define, govern, and validate design rationales across the entire file range
 * without standard parsing friction.
 */

import { readFileSync, statSync } from 'node:fs';
import { extname, basename } from 'node:path';
import type {
  FileRecord, Section, ParseResult, FileKind, AbsPath, Hash,
} from '../types/index.js';
import {
  fileId as makeFileId,
  sectionId as makeSectionId,
  sectionHash,
  hashBytes,
} from '../chain/fingerprint.js';

// ─── File Kind Detection ───────────────────────────────────────────────────────

export function detectFileKind(path: AbsPath): FileKind {
  const ext = extname(path).toLowerCase();
  const base = basename(path).toLowerCase();

  if (base === '.env' || base.startsWith('.env.')) return 'env';
  if (base === 'package.json' || base === 'tsconfig.json' || base === '.eslintrc.json') return 'json';

  switch (ext) {
    case '.ts': case '.tsx': case '.mts': case '.cts': return 'typescript';
    case '.js': case '.jsx': case '.mjs': case '.cjs': return 'javascript';
    case '.py': return 'python';
    case '.json': case '.jsonc': return 'json';
    case '.yaml': case '.yml': return 'yaml';
    case '.toml': return 'toml';
    case '.md': case '.mdx': case '.markdown': return 'markdown';
    case '.html': case '.htm': case '.hbs': case '.jinja': case '.j2': return 'html';
    case '.css': case '.scss': case '.sass': case '.less': return 'css';
    case '.env': return 'env';
    case '.txt': return 'text';
    default: return 'unknown';
  }
}

// ─── Main Parse Entry Point (Agent Brain Only) ─────────────────────────────────

export function parseFile(absolutePath: AbsPath): ParseResult | null {
  const normPath = absolutePath.replace(/\\/g, '/') as AbsPath;
  let rawBytes: Buffer;
  let stat: ReturnType<typeof statSync>;

  try {
    stat = statSync(normPath);
    if (stat.size > 2 * 1024 * 1024) return null; // skip files > 2MB
    rawBytes = readFileSync(normPath);
  } catch {
    return null;
  }

  const rawText = rawBytes.toString('utf8');
  const contentHash = hashBytes(rawBytes);
  const kind = detectFileKind(normPath);
  const fId = makeFileId(normPath);
  const lines = rawText.split('\n');

  const fileRecord: FileRecord = {
    id: fId,
    path: normPath,
    kind,
    contentHash,
    mtimeMs: stat.mtimeMs,
    indexedAt: Date.now(),
    sectionCount: 1,
  };

  // Treat the entire file as a single section, governed wholly by the Agent's brain
  const sections: Section[] = [
    {
      id: makeSectionId(fId, 1, lines.length),
      fileId: fId,
      filePath: normPath,
      lineStart: 1,
      lineEnd: lines.length,
      contentHash: sectionHash(rawText),
      rawText,
      kind: 'code_module',
    }
  ];

  return { file: fileRecord, sections, facts: [], entities: [] };
}
