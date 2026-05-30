/**
 * SQLite Database Layer
 *
 * Schema creation, migrations, and all graph operations.
 * Uses better-sqlite3 for synchronous, zero-async SQLite access.
 * WAL mode enabled for concurrent reads during real-time analysis.
 *
 * Design principles:
 * - ALL writes are synchronous (better-sqlite3)
 * - Recursive CTEs for graph traversal (no ORM, raw SQL)
 * - Append-only audit log (immutable history)
 * - All hashes are TEXT (64-char hex) — never binary blobs
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  FileRecord, Section, SyntacticFact, StructuralEntity,
  Concept, BusinessRule, RuleInstance, Edge, AuditEntry,
  Hash, AbsPath, ChainState, EdgeType,
} from '../types/index.js';

// ─── Schema SQL ────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA cache_size = -16000;   -- 16MB cache

-- Version tracking for schema migrations
CREATE TABLE IF NOT EXISTS schema_version (
  version   INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- ── Files ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS files (
  id           TEXT PRIMARY KEY,   -- SHA3-256(abs_path)
  path         TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL,      -- FileKind
  content_hash TEXT NOT NULL,      -- SHA3-256(file bytes)
  mtime_ms     INTEGER NOT NULL,
  indexed_at   INTEGER NOT NULL,
  section_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);

-- ── Sections ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sections (
  id           TEXT PRIMARY KEY,   -- SHA3-256(file_id:lineStart:lineEnd)
  file_id      TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  line_start   INTEGER NOT NULL,
  line_end     INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  raw_text     TEXT NOT NULL,
  kind         TEXT NOT NULL       -- SectionKind
);
CREATE INDEX IF NOT EXISTS idx_sections_file ON sections(file_id);
CREATE INDEX IF NOT EXISTS idx_sections_hash ON sections(content_hash);

-- ── Syntactic Facts ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS syntactic_facts (
  id         TEXT PRIMARY KEY,
  section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  file_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,        -- SyntacticFactKind
  symbol     TEXT NOT NULL,
  scope      TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_symbol ON syntactic_facts(symbol);
CREATE INDEX IF NOT EXISTS idx_facts_section ON syntactic_facts(section_id);

-- ── Structural Entities ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS structural_entities (
  id          TEXT PRIMARY KEY,
  section_id  TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  file_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,       -- EntityKind
  value       TEXT NOT NULL,
  normalized  TEXT NOT NULL,
  line_start  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entities_normalized ON structural_entities(normalized);
CREATE INDEX IF NOT EXISTS idx_entities_kind ON structural_entities(kind);

-- ── Concepts ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS concepts (
  id           TEXT PRIMARY KEY,   -- ConceptID = SHA3-256(canonical|label|scope)
  label        TEXT NOT NULL,
  canonical    TEXT NOT NULL,
  section_id   TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  file_id      TEXT NOT NULL,
  confidence   TEXT NOT NULL,      -- STRUCTURAL | CONSENSUS | SINGLE_MODEL
  chain_link   TEXT NOT NULL,      -- cryptographic binding
  chain_state  TEXT NOT NULL DEFAULT 'VALID',  -- VALID | CHAIN_BROKEN | ACKNOWLEDGED_DRIFT
  broken_at    INTEGER,
  ack_at       INTEGER,
  ack_by       TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_concepts_label ON concepts(label);
CREATE INDEX IF NOT EXISTS idx_concepts_section ON concepts(section_id);
CREATE INDEX IF NOT EXISTS idx_concepts_state ON concepts(chain_state);

-- ── Business Rules ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_rules (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL UNIQUE,
  value       TEXT,
  description TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

-- ── Rule Instances ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rule_instances (
  rule_id     TEXT NOT NULL REFERENCES business_rules(id) ON DELETE CASCADE,
  section_id  TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  file_id     TEXT NOT NULL,
  encoded_as  TEXT NOT NULL,       -- constant | string_literal | prose_statement | config_value
  raw_value   TEXT,
  chain_link  TEXT NOT NULL,
  chain_state TEXT NOT NULL DEFAULT 'VALID',
  PRIMARY KEY (rule_id, section_id)
);
CREATE INDEX IF NOT EXISTS idx_rule_instances_state ON rule_instances(chain_state);

-- ── Edges ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS edges (
  id           TEXT PRIMARY KEY,
  from_id      TEXT NOT NULL,      -- section id
  to_id        TEXT NOT NULL,      -- section id
  edge_type    TEXT NOT NULL,
  weight       REAL NOT NULL DEFAULT 1.0,
  evidence     TEXT NOT NULL,      -- JSON
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(edge_type);
-- Prevent duplicate edges of same type
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique ON edges(from_id, to_id, edge_type);

-- ── Audit Log (append-only) ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT NOT NULL,
  section_id  TEXT,
  concept_id  TEXT,
  rule_id     TEXT,
  old_hash    TEXT,
  new_hash    TEXT,
  timestamp_ms INTEGER NOT NULL,
  actor       TEXT NOT NULL,
  meta        TEXT NOT NULL DEFAULT '{}'  -- JSON
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(timestamp_ms);
CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_log(event_type);
`;

// ─── Database Class ────────────────────────────────────────────────────────────

export class GraphDB {
  private db: Database.Database;

  constructor(dbPath: AbsPath) {
    // Ensure directory exists
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.applySchema();
  }

  private applySchema(): void {
    this.db.exec(SCHEMA_SQL);
    // Record schema version if not already present
    const hasVersion = this.db
      .prepare('SELECT version FROM schema_version WHERE version = 1')
      .get();
    if (!hasVersion) {
      this.db
        .prepare('INSERT INTO schema_version (version, applied_at) VALUES (1, ?)')
        .run(Date.now());
    }
  }

  close(): void {
    this.db.close();
  }

  // ─── File Operations ──────────────────────────────────────────────────────────

  upsertFile(file: FileRecord): void {
    this.db.prepare(`
      INSERT INTO files (id, path, kind, content_hash, mtime_ms, indexed_at, section_count)
      VALUES (@id, @path, @kind, @contentHash, @mtimeMs, @indexedAt, @sectionCount)
      ON CONFLICT(id) DO UPDATE SET
        content_hash = excluded.content_hash,
        mtime_ms     = excluded.mtime_ms,
        indexed_at   = excluded.indexed_at,
        section_count = excluded.section_count
    `).run(file);
  }

  getFile(id: Hash): FileRecord | undefined {
    return this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRecord | undefined;
  }

  getFileByPath(path: AbsPath): FileRecord | undefined {
    return this.db.prepare('SELECT * FROM files WHERE path = ?').get(path) as FileRecord | undefined;
  }

  getAllFiles(): FileRecord[] {
    return this.db.prepare('SELECT * FROM files ORDER BY path').all() as FileRecord[];
  }

  // ─── Section Operations ───────────────────────────────────────────────────────

  insertSection(section: Section): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO sections
        (id, file_id, line_start, line_end, content_hash, raw_text, kind)
      VALUES
        (@id, @fileId, @lineStart, @lineEnd, @contentHash, @rawText, @kind)
    `).run(section);
  }

  getSectionsForFile(fileId: Hash): Section[] {
    return this.db
      .prepare('SELECT * FROM sections WHERE file_id = ? ORDER BY line_start')
      .all(fileId) as Section[];
  }

  deleteFileData(fileId: Hash): void {
    // Cascade deletes sections, facts, entities, concepts
    this.db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
  }

  // ─── Syntactic Facts ──────────────────────────────────────────────────────────

  insertFacts(facts: SyntacticFact[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO syntactic_facts
        (id, section_id, file_id, kind, symbol, scope, line_start, line_end)
      VALUES
        (@id, @sectionId, @fileId, @kind, @symbol, @scope, @lineStart, @lineEnd)
    `);
    const insertMany = this.db.transaction((rows: SyntacticFact[]) => {
      for (const row of rows) stmt.run({ ...row, id: `${row.sectionId}:${row.kind}:${row.symbol}:${row.lineStart}` });
    });
    insertMany(facts);
  }

  findFactsBySymbol(symbol: string): SyntacticFact[] {
    return this.db
      .prepare('SELECT * FROM syntactic_facts WHERE symbol = ?')
      .all(symbol) as SyntacticFact[];
  }

  // ─── Structural Entities ──────────────────────────────────────────────────────

  insertEntities(entities: StructuralEntity[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO structural_entities
        (id, section_id, file_id, kind, value, normalized, line_start)
      VALUES
        (@id, @sectionId, @fileId, @kind, @value, @normalized, @lineStart)
    `);
    const insertMany = this.db.transaction((rows: StructuralEntity[]) => {
      for (const row of rows) stmt.run({ ...row, id: `${row.sectionId}:${row.kind}:${row.normalized}` });
    });
    insertMany(entities);
  }

  findEntityByNormalized(normalized: string): StructuralEntity[] {
    return this.db
      .prepare('SELECT * FROM structural_entities WHERE normalized = ?')
      .all(normalized) as StructuralEntity[];
  }

  getEntitiesForFile(fileId: Hash): StructuralEntity[] {
    return this.db
      .prepare('SELECT * FROM structural_entities WHERE file_id = ?')
      .all(fileId) as StructuralEntity[];
  }

  // ─── Concepts ─────────────────────────────────────────────────────────────────

  upsertConcept(concept: Concept): void {
    this.db.prepare(`
      INSERT INTO concepts
        (id, label, canonical, section_id, file_id, confidence, chain_link, chain_state,
         broken_at, ack_at, ack_by, created_at, updated_at)
      VALUES
        (@id, @label, @canonical, @sectionId, @fileId, @confidence, @chainLink, @chainState,
         @brokenAt, @ackAt, @ackBy, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        chain_link  = excluded.chain_link,
        chain_state = excluded.chain_state,
        broken_at   = excluded.broken_at,
        ack_at      = excluded.ack_at,
        ack_by      = excluded.ack_by,
        updated_at  = excluded.updated_at
    `).run({
      id: concept.id,
      label: concept.label,
      canonical: concept.canonical,
      sectionId: concept.sectionId,
      fileId: concept.fileId,
      confidence: concept.confidence,
      chainLink: concept.chainLink,
      chainState: concept.chainState,
      brokenAt: concept.brokenAt ?? null,
      ackAt: concept.ackAt ?? null,
      ackBy: concept.ackBy ?? null,
      createdAt: concept.createdAt,
      updatedAt: concept.updatedAt,
    });
  }

  getConceptsForSection(sectionId: Hash): Concept[] {
    return this.db
      .prepare('SELECT * FROM concepts WHERE section_id = ?')
      .all(sectionId) as Concept[];
  }

  getConceptsByLabel(label: string): Concept[] {
    return this.db
      .prepare('SELECT * FROM concepts WHERE label = ? ORDER BY file_id')
      .all(label) as Concept[];
  }

  getBrokenConcepts(): Concept[] {
    return this.db
      .prepare("SELECT * FROM concepts WHERE chain_state = 'CHAIN_BROKEN'")
      .all() as Concept[];
  }

  getBrokenConceptsForFile(fileId: Hash): Concept[] {
    return this.db
      .prepare("SELECT * FROM concepts WHERE file_id = ? AND chain_state = 'CHAIN_BROKEN'")
      .all(fileId) as Concept[];
  }

  /**
   * Get all broken concepts joined with section and file location data.
   * Use this for CLI display and review — avoids N+1 queries.
   */
  getBrokenConceptsWithLocations(): Array<Concept & { filePath: AbsPath; lineStart: number; lineEnd: number }> {
    return this.db.prepare(`
      SELECT
        c.*,
        f.path     AS filePath,
        s.line_start AS lineStart,
        s.line_end   AS lineEnd
      FROM concepts c
      JOIN sections s ON c.section_id = s.id
      JOIN files    f ON c.file_id    = f.id
      WHERE c.chain_state = 'CHAIN_BROKEN'
      ORDER BY f.path, s.line_start
    `).all() as Array<Concept & { filePath: AbsPath; lineStart: number; lineEnd: number }>;
  }

  /**
   * Get broken concepts for a specific file, joined with section location.
   */
  getBrokenConceptsForFileWithLocations(fileId: Hash): Array<Concept & { filePath: AbsPath; lineStart: number; lineEnd: number }> {
    return this.db.prepare(`
      SELECT
        c.*,
        f.path       AS filePath,
        s.line_start AS lineStart,
        s.line_end   AS lineEnd
      FROM concepts c
      JOIN sections s ON c.section_id = s.id
      JOIN files    f ON c.file_id    = f.id
      WHERE c.file_id = ? AND c.chain_state = 'CHAIN_BROKEN'
      ORDER BY s.line_start
    `).all(fileId) as Array<Concept & { filePath: AbsPath; lineStart: number; lineEnd: number }>;
  }

  // ─── Business Rules ───────────────────────────────────────────────────────────

  upsertBusinessRule(rule: BusinessRule): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO business_rules (id, label, value, description, created_at)
      VALUES (@id, @label, @value, @description, @createdAt)
    `).run(rule);
  }

  insertRuleInstance(instance: RuleInstance): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO rule_instances
        (rule_id, section_id, file_id, encoded_as, raw_value, chain_link, chain_state)
      VALUES
        (@ruleId, @sectionId, @fileId, @encodedAs, @rawValue, @chainLink, @chainState)
    `).run(instance);
  }

  getBrokenRuleInstances(): Array<RuleInstance & { ruleLabel: string }> {
    return this.db.prepare(`
      SELECT ri.*, br.label as ruleLabel
      FROM rule_instances ri
      JOIN business_rules br ON ri.rule_id = br.id
      WHERE ri.chain_state = 'CHAIN_BROKEN'
    `).all() as Array<RuleInstance & { ruleLabel: string }>;
  }

  // ─── Edges ────────────────────────────────────────────────────────────────────

  insertEdge(edge: Edge): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO edges
        (id, from_id, to_id, edge_type, weight, evidence, created_at)
      VALUES
        (@id, @fromId, @toId, @edgeType, @weight, @evidence, @createdAt)
    `).run({ ...edge, evidence: JSON.stringify(edge.evidence) });
  }

  getEdgesFrom(sectionId: Hash): Edge[] {
    const rows = this.db
      .prepare('SELECT * FROM edges WHERE from_id = ?')
      .all(sectionId) as Array<Omit<Edge, 'evidence'> & { evidence: string }>;
    return rows.map(r => ({ ...r, evidence: JSON.parse(r.evidence) as Edge['evidence'] }));
  }

  getEdgesTo(sectionId: Hash): Edge[] {
    const rows = this.db
      .prepare('SELECT * FROM edges WHERE to_id = ?')
      .all(sectionId) as Array<Omit<Edge, 'evidence'> & { evidence: string }>;
    return rows.map(r => ({ ...r, evidence: JSON.parse(r.evidence) as Edge['evidence'] }));
  }

  // ─── Graph Traversal (Recursive CTE) ─────────────────────────────────────────

  /**
   * Blast radius query — find ALL sections affected by changes in given sections.
   * Uses recursive CTE with depth limit to prevent infinite loops.
   *
   * Returns sections ordered by depth (direct neighbors first) and severity.
   */
  getBlastRadius(sectionIds: Hash[], maxDepth = 8): Array<{
    sectionId: Hash;
    fileId: Hash;
    filePath: AbsPath;
    edgeType: EdgeType;
    depth: number;
    lineStart: number;
    lineEnd: number;
    kind: string;
    chainState: ChainState;
  }> {
    if (sectionIds.length === 0) return [];

    // Build parameterized IN clause
    const placeholders = sectionIds.map(() => '?').join(',');

    const query = `
      WITH RECURSIVE blast(section_id, depth, edge_type, path) AS (
        -- Base: direct neighbors of changed sections
        SELECT
          e.to_id,
          1,
          e.edge_type,
          e.from_id || '->' || e.to_id
        FROM edges e
        WHERE e.from_id IN (${placeholders})

        UNION

        -- Recursive: neighbors of neighbors
        SELECT
          e.to_id,
          b.depth + 1,
          e.edge_type,
          b.path || '->' || e.to_id
        FROM edges e
        JOIN blast b ON e.from_id = b.section_id
        WHERE b.depth < ?
          AND b.path NOT LIKE '%' || e.to_id || '%'  -- cycle guard
      )
      SELECT DISTINCT
        b.section_id,
        s.file_id,
        f.path as file_path,
        b.edge_type,
        MIN(b.depth) as depth,
        s.line_start,
        s.line_end,
        s.kind,
        COALESCE(c.chain_state, 'VALID') as chain_state
      FROM blast b
      JOIN sections s ON b.section_id = s.id
      JOIN files f ON s.file_id = f.id
      LEFT JOIN concepts c ON c.section_id = s.id
      WHERE b.section_id NOT IN (${placeholders})
      GROUP BY b.section_id
      ORDER BY depth ASC, f.path ASC
    `;

    return this.db
      .prepare(query)
      .all([...sectionIds, maxDepth, ...sectionIds]) as Array<{
        sectionId: Hash;
        fileId: Hash;
        filePath: AbsPath;
        edgeType: EdgeType;
        depth: number;
        lineStart: number;
        lineEnd: number;
        kind: string;
        chainState: ChainState;
      }>;
  }

  /**
   * Find all sections that encode the same concept label.
   * Used by concept_query MCP tool.
   */
  getConceptLocations(label: string): Array<{ filePath: AbsPath; lineStart: number; lineEnd: number; chainState: ChainState; confidence: string }> {
    return this.db.prepare(`
      SELECT f.path as filePath, s.line_start as lineStart, s.line_end as lineEnd,
             c.chain_state as chainState, c.confidence
      FROM concepts c
      JOIN sections s ON c.section_id = s.id
      JOIN files f ON s.file_id = f.id
      WHERE c.label = ?
      ORDER BY f.path, s.line_start
    `).all(label) as Array<{ filePath: AbsPath; lineStart: number; lineEnd: number; chainState: ChainState; confidence: string }>;
  }

  /**
   * Get overall chain health summary for a project.
   */
  getChainHealthSummary(): {
    totalConcepts: number;
    brokenChains: number;
    acknowledgedDrift: number;
    validChains: number;
    totalEdges: number;
    totalFiles: number;
  } {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as totalConcepts,
        COALESCE(SUM(CASE WHEN chain_state = 'CHAIN_BROKEN' THEN 1 ELSE 0 END), 0) as brokenChains,
        COALESCE(SUM(CASE WHEN chain_state = 'ACKNOWLEDGED_DRIFT' THEN 1 ELSE 0 END), 0) as acknowledgedDrift,
        COALESCE(SUM(CASE WHEN chain_state = 'VALID' THEN 1 ELSE 0 END), 0) as validChains
      FROM concepts
    `).get() as { totalConcepts: number; brokenChains: number; acknowledgedDrift: number; validChains: number };

    const edges = this.db.prepare('SELECT COUNT(*) as n FROM edges').get() as { n: number };
    const files = this.db.prepare('SELECT COUNT(*) as n FROM files').get() as { n: number };

    return { ...row, totalEdges: edges.n, totalFiles: files.n };
  }

  // ─── Audit Log ────────────────────────────────────────────────────────────────

  appendAudit(entry: AuditEntry): void {
    this.db.prepare(`
      INSERT INTO audit_log
        (event_type, section_id, concept_id, rule_id, old_hash, new_hash, timestamp_ms, actor, meta)
      VALUES
        (@eventType, @sectionId, @conceptId, @ruleId, @oldHash, @newHash, @timestampMs, @actor, @meta)
    `).run({ ...entry, meta: JSON.stringify(entry.meta) });
  }

  getRecentAudit(limit = 50): AuditEntry[] {
    return this.db
      .prepare('SELECT * FROM audit_log ORDER BY timestamp_ms DESC LIMIT ?')
      .all(limit) as AuditEntry[];
  }

  // ─── Transaction Wrapper ──────────────────────────────────────────────────────

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
