/**
 * File Parser & Chunker
 *
 * Converts any supported file type into a list of Sections.
 * Each Section is a semantically meaningful chunk of the file.
 *
 * Supported:
 *   TypeScript/JavaScript — @babel/parser AST
 *   Markdown              — remark AST (headings + paragraphs)
 *   JSON                  — top-level key blocks
 *   YAML                  — top-level key blocks
 *   .env                  — variable groups
 *   Plain text            — sliding window paragraphs
 */

import { readFileSync, statSync } from 'node:fs';
import { extname, basename } from 'node:path';
import { parse as babelParse } from '@babel/parser';
import _traverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import type {
  FunctionDeclaration, ArrowFunctionExpression, ClassDeclaration,
} from '@babel/types';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit as mdVisit } from 'unist-util-visit';
import type { Root as MdRoot } from 'mdast';
import { parse as parseYaml } from 'yaml';
import type {
  FileRecord, Section, SyntacticFact, ParseResult,
  FileKind, SectionKind, AbsPath, Hash,
} from '../types/index.js';
import {
  fileId as makeFileId,
  sectionId as makeSectionId,
  sectionHash,
  hashBytes,
} from '../chain/fingerprint.js';
import { extractStructuralEntities } from './structural.js';

// babel/traverse is a CommonJS module with a default export that might be wrapped
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const traverse = (_traverse as any).default ?? _traverse as any;

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

// ─── Main Parse Entry Point ────────────────────────────────────────────────────

export function parseFile(absolutePath: AbsPath): ParseResult | null {
  let rawBytes: Buffer;
  let stat: ReturnType<typeof statSync>;

  try {
    stat = statSync(absolutePath);
    if (stat.size > 2 * 1024 * 1024) return null; // skip files > 2MB
    rawBytes = readFileSync(absolutePath);
  } catch {
    return null;
  }

  const rawText = rawBytes.toString('utf8');
  const contentHash = hashBytes(rawBytes);
  const kind = detectFileKind(absolutePath);
  const fId = makeFileId(absolutePath);

  const fileRecord: FileRecord = {
    id: fId,
    path: absolutePath,
    kind,
    contentHash,
    mtimeMs: stat.mtimeMs,
    indexedAt: Date.now(),
    sectionCount: 0,
  };

  let sections: Section[] = [];
  let facts: SyntacticFact[] = [];

  switch (kind) {
    case 'typescript':
    case 'javascript': {
      const result = parseJsTs(rawText, fId);
      sections = result.sections;
      facts = result.facts;
      break;
    }
    case 'markdown':
      sections = parseMarkdown(rawText, fId);
      break;
    case 'json':
      sections = parseJson(rawText, fId);
      break;
    case 'yaml':
      sections = parseYamlFile(rawText, fId);
      break;
    case 'env':
      sections = parseEnvFile(rawText, fId);
      break;
    default:
      sections = parsePlainText(rawText, fId);
      break;
  }

  const finalSections = sections
    .filter(s => s.rawText.trim().length > 10)
    .map(s => ({ ...s, filePath: absolutePath }));

  fileRecord.sectionCount = finalSections.length;

  const allEntities = finalSections.flatMap(section =>
    extractStructuralEntities({
      text: section.rawText,
      sectionId: section.id,
      fileId: fId,
      lineStart: section.lineStart,
    })
  );

  return { file: fileRecord, sections: finalSections, facts, entities: allEntities };
}

// ─── JS/TS Parser ─────────────────────────────────────────────────────────────

function parseJsTs(code: string, fId: Hash): { sections: Section[]; facts: SyntacticFact[] } {
  const sections: Section[] = [];
  const facts: SyntacticFact[] = [];
  const lines = code.split('\n');

  let ast: ReturnType<typeof babelParse>;
  try {
    ast = babelParse(code, {
      sourceType: 'module',
      allowImportExportEverywhere: true,
      allowReturnOutsideFunction: true,
      allowSuperOutsideMethod: true,
      plugins: [
        'typescript', 'jsx', 'decorators',
        'classProperties', 'classPrivateProperties', 'classPrivateMethods',
        'optionalChaining', 'nullishCoalescingOperator',
      ],
    });
  } catch {
    return { sections: [makeSection(fId, code, 1, lines.length, 'code_module')], facts: [] };
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  traverse(ast, {
    ImportDeclaration(path: NodePath) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const node = path.node as any;
      const lineStart = (node.loc?.start.line as number) ?? 1;
      const symbol = node.source.value as string;
      facts.push({
        kind: 'import',
        symbol,
        scope: 'module',
        lineStart,
        lineEnd: (node.loc?.end.line as number) ?? lineStart,
        sectionId: makeSectionId(fId, lineStart, lineStart),
        fileId: fId,
      });
    },

    ExportNamedDeclaration(path: NodePath) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const node = path.node as any;
      if (!node.declaration) return;
      const lineStart = (node.loc?.start.line as number) ?? 1;

      if (node.declaration.type === 'FunctionDeclaration' && node.declaration.id) {
        facts.push({
          kind: 'export',
          symbol: node.declaration.id.name as string,
          scope: 'module',
          lineStart,
          lineEnd: (node.loc?.end.line as number) ?? lineStart,
          sectionId: makeSectionId(fId, lineStart, lineStart),
          fileId: fId,
        });
      }
      if (node.declaration.type === 'VariableDeclaration') {
        for (const d of (node.declaration.declarations as Array<{ id: { type: string; name: string } }>)) {
          if (d.id.type === 'Identifier') {
            facts.push({
              kind: 'export',
              symbol: d.id.name,
              scope: 'module',
              lineStart,
              lineEnd: (node.loc?.end.line as number) ?? lineStart,
              sectionId: makeSectionId(fId, lineStart, lineStart),
              fileId: fId,
            });
          }
        }
      }
    },

    FunctionDeclaration(path: NodePath) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const node = path.node as any;
      if (!node.id) return;
      const lineStart = (node.loc?.start.line as number) ?? 1;
      const lineEnd = (node.loc?.end.line as number) ?? lineStart;
      sections.push(makeSection(fId, extractLines(lines, lineStart, lineEnd), lineStart, lineEnd, 'code_function'));
    },

    VariableDeclaration(path: NodePath) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const node = path.node as any;
      if (path.parent.type !== 'Program' && path.parent.type !== 'ExportNamedDeclaration') return;
      const lineStart = (node.loc?.start.line as number) ?? 1;
      const lineEnd = (node.loc?.end.line as number) ?? lineStart;
      if (lineEnd - lineStart < 2) return;
      sections.push(makeSection(fId, extractLines(lines, lineStart, lineEnd), lineStart, lineEnd, 'code_function'));
    },

    ClassDeclaration(path: NodePath) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const node = path.node as any;
      const lineStart = (node.loc?.start.line as number) ?? 1;
      const lineEnd = (node.loc?.end.line as number) ?? lineStart;
      sections.push(makeSection(fId, extractLines(lines, lineStart, lineEnd), lineStart, lineEnd, 'code_class'));
    },

    StringLiteral(path: NodePath) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const node = path.node as any;
      const value = node.value as string;
      const lineStart = (node.loc?.start.line as number) ?? 1;
      if (value.length > 8 && !/^[./\\]/.test(value)) {
        facts.push({
          kind: 'string_literal',
          symbol: value,
          scope: getScopeStr(path),
          lineStart,
          lineEnd: lineStart,
          sectionId: makeSectionId(fId, lineStart, lineStart),
          fileId: fId,
        });
      }
    },

    NumericLiteral(path: NodePath) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const node = path.node as any;
      const value = node.value as number;
      const lineStart = (node.loc?.start.line as number) ?? 1;
      if (value > 2 && !isLikelyIndex(path)) {
        facts.push({
          kind: 'numeric_literal',
          symbol: String(value),
          scope: getScopeStr(path),
          lineStart,
          lineEnd: lineStart,
          sectionId: makeSectionId(fId, lineStart, lineStart),
          fileId: fId,
        });
      }
    },
  });

  // Always include a module-level section to cover the whole file (imports, exports, top-level constants)
  sections.push(makeSection(fId, code, 1, lines.length, 'code_module'));

  // Map each fact to the most specific enclosing section
  for (const fact of facts) {
    let bestSection: Section | null = null;
    let minSpan = Infinity;

    for (const section of sections) {
      if (fact.lineStart >= section.lineStart && fact.lineStart <= section.lineEnd) {
        const span = section.lineEnd - section.lineStart;
        if (span < minSpan) {
          minSpan = span;
          bestSection = section;
        }
      }
    }

    if (bestSection) {
      fact.sectionId = bestSection.id;
    } else if (sections.length > 0) {
      fact.sectionId = sections[0]!.id;
    }
  }

  return { sections, facts };
}

// ─── Markdown Parser ──────────────────────────────────────────────────────────

function parseMarkdown(text: string, fId: Hash): Section[] {
  const sections: Section[] = [];
  const lines = text.split('\n');

  const ast = unified().use(remarkParse).parse(text) as MdRoot;

  let currentHeadingLine = 1;
  let currentContent: string[] = [];

  mdVisit(ast, (node) => {
    if (node.type === 'heading') {
      if (currentContent.length > 0) {
        const joined = currentContent.join('\n');
        const endLine = (node.position?.start.line ?? currentHeadingLine + 1) - 1;
        const section = makeSection(fId, joined, currentHeadingLine, endLine, 'doc_heading');
        if (section.rawText.trim().length > 15) sections.push(section);
      }
      currentHeadingLine = node.position?.start.line ?? 1;
      currentContent = [extractLines(lines, currentHeadingLine, currentHeadingLine)];
    } else if (node.type === 'paragraph' || node.type === 'list' || node.type === 'code') {
      const start = node.position?.start.line ?? currentHeadingLine;
      const end = node.position?.end.line ?? start;
      currentContent.push(extractLines(lines, start, end));
    }
  });

  if (currentContent.length > 0) {
    const section = makeSection(fId, currentContent.join('\n'), currentHeadingLine, lines.length, 'doc_heading');
    if (section.rawText.trim().length > 15) sections.push(section);
  }

  if (sections.length === 0) {
    sections.push(makeSection(fId, text, 1, lines.length, 'doc_paragraph'));
  }

  return sections;
}

// ─── JSON Parser ──────────────────────────────────────────────────────────────

function parseJson(text: string, fId: Hash): Section[] {
  const lines = text.split('\n');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return [makeSection(fId, text, 1, lines.length, 'config_block')];
  }

  const sections: Section[] = [];
  let lineNum = 1;
  for (const [key, value] of Object.entries(parsed)) {
    const serialized = JSON.stringify({ [key]: value }, null, 2);
    const endLine = lineNum + serialized.split('\n').length;
    sections.push(makeSection(fId, `"${key}": ${JSON.stringify(value, null, 2)}`, lineNum, Math.min(endLine, lines.length), 'config_block'));
    lineNum = endLine + 1;
  }
  return sections.length > 0 ? sections : [makeSection(fId, text, 1, lines.length, 'config_block')];
}

// ─── YAML Parser ──────────────────────────────────────────────────────────────

function parseYamlFile(text: string, fId: Hash): Section[] {
  const lines = text.split('\n');
  let parsed: unknown;
  try { parsed = parseYaml(text); } catch {
    return [makeSection(fId, text, 1, lines.length, 'config_block')];
  }
  if (typeof parsed !== 'object' || !parsed) {
    return [makeSection(fId, text, 1, lines.length, 'config_block')];
  }
  const sections: Section[] = [];
  let lineNum = 1;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const chunk = `${key}:\n  ${JSON.stringify(value, null, 2).split('\n').join('\n  ')}`;
    const chunkLines = chunk.split('\n').length;
    sections.push(makeSection(fId, chunk, lineNum, Math.min(lineNum + chunkLines, lines.length), 'config_block'));
    lineNum += chunkLines + 1;
  }
  return sections.length > 0 ? sections : [makeSection(fId, text, 1, lines.length, 'config_block')];
}

// ─── .env Parser ──────────────────────────────────────────────────────────────

function parseEnvFile(text: string, fId: Hash): Section[] {
  const lines = text.split('\n');
  const sections: Section[] = [];
  let blockStart = 1;
  let blockLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      if (blockLines.length > 0) {
        sections.push(makeSection(fId, blockLines.join('\n'), blockStart, i, 'env_block'));
        blockLines = [];
        blockStart = i + 2;
      }
    } else {
      blockLines.push(line);
    }
  }
  if (blockLines.length > 0) {
    sections.push(makeSection(fId, blockLines.join('\n'), blockStart, lines.length, 'env_block'));
  }
  return sections.length > 0 ? sections : [makeSection(fId, text, 1, lines.length, 'env_block')];
}

// ─── Plain Text Parser ────────────────────────────────────────────────────────

function parsePlainText(text: string, fId: Hash): Section[] {
  const lines = text.split('\n');
  const CHUNK = 30;
  const sections: Section[] = [];
  for (let i = 0; i < lines.length; i += CHUNK) {
    const chunk = lines.slice(i, i + CHUNK).join('\n');
    sections.push(makeSection(fId, chunk, i + 1, Math.min(i + CHUNK, lines.length), 'doc_paragraph'));
  }
  return sections;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSection(fId: Hash, rawText: string, lineStart: number, lineEnd: number, kind: SectionKind): Section {
  return {
    id: makeSectionId(fId, lineStart, lineEnd),
    fileId: fId,
    filePath: '' as AbsPath,
    lineStart,
    lineEnd,
    contentHash: sectionHash(rawText),
    rawText,
    kind,
  };
}

function extractLines(lines: string[], start: number, end: number): string {
  return lines.slice(start - 1, end).join('\n');
}

function getScopeStr(path: NodePath): string {
  let current = path.parentPath;
  while (current) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = current.node as any;
    if (current.isFunctionDeclaration() && n.id) return n.id.name as string;
    if (current.isArrowFunctionExpression()) return 'arrow';
    if (current.isClassDeclaration() && n.id) return n.id.name as string;
    current = current.parentPath;
  }
  return 'module';
}

function isLikelyIndex(path: NodePath): boolean {
  return path.parent.type === 'MemberExpression' || path.parent.type === 'BinaryExpression';
}
