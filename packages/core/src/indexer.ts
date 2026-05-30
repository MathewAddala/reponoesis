/**
 * Main Indexer
 *
 * Orchestrates the full indexing pipeline for a project:
 *   1. Scan files (glob, filter, detect changes)
 *   2. Parse each file (AST + structural extraction)
 *   3. Extract concepts (AI consensus)
 *   4. Build Merkle chain links
 *   5. Detect cross-file edges (syntactic + semantic)
 *   6. Store everything in the graph DB
 *   7. Validate chain integrity across the whole graph
 *
 * Also handles incremental re-indexing (changed files only).
 */

import { glob } from 'glob';
import pLimit from 'p-limit';
import type {
  AbsPath, Hash, Concept, ConceptLabel, Edge,
  EngineConfig, Section, StructuralEntity,
  ParseResult, ChainState, EdgeType, ImpactSeverity,
} from './types/index.js';
import { GraphDB } from './db/graph.js';
import { parseFile } from './parser/chunker.js';
import { extractConcepts } from './ai/extractor.js';
import {
  sectionHash,
  conceptId as makeConceptId,
  buildChainLink,
  validateChainLink,
  normalizeForFingerprint,
  edgeWeight,
  impactSeverity,
} from './chain/fingerprint.js';

// ─── Default ignore patterns ───────────────────────────────────────────────────

const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/.engine/**',
  '**/*.min.js',
  '**/*.map',
  '**/coverage/**',
  '**/__pycache__/**',
  '**/*.pyc',
  '**/.venv/**',
  '**/vendor/**',
];

// ─── Public Result Types ───────────────────────────────────────────────────────

export interface ScanResult {
  filesIndexed: number;
  conceptsFound: number;
  edgesCreated: number;
  brokenChains: number;
  durationMs: number;
}

export interface IncrementalResult {
  reindexed: number;
  brokenChains: number;
  impactedSections: number;
  durationMs: number;
}

/** A broken chain entry enriched with file location info — used by CLI & MCP */
export interface BrokenChainEntry {
  conceptId: Hash;
  conceptLabel: string;
  filePath: AbsPath;
  fileId: Hash;
  sectionId: Hash;
  lineStart: number;
  lineEnd: number;
  severity: ImpactSeverity;
  chainLink: Hash;
  confidence: string;
  reason: string;
}

// ─── Indexer Class ─────────────────────────────────────────────────────────────

export class Indexer {
  private db: GraphDB;
  private config: EngineConfig;

  constructor(config: EngineConfig) {
    this.config = config;
    this.db = new GraphDB(config.dbPath);
  }

  close(): void {
    this.db.close();
  }

  // ─── Full Project Scan ────────────────────────────────────────────────────────

  async fullScan(onProgress?: (msg: string) => void): Promise<ScanResult> {
    const startMs = Date.now();
    const projectRoot = this.config.projectRoot;

    onProgress?.(`🔍 Scanning ${projectRoot}...`);

    const allPaths = await glob('**/*', {
      cwd: projectRoot,
      absolute: true,
      nodir: true,
      ignore: [...DEFAULT_IGNORE, ...this.config.ignorePaths],
    });

    onProgress?.(`📁 Found ${allPaths.length} files`);

    const limit = pLimit(8);
    const parseResults = await Promise.all(
      allPaths.map((p) =>
        limit(() => parseFile(p as AbsPath))
      )
    );

    const valid = parseResults.filter((r): r is ParseResult => r !== null);
    onProgress?.(`⚙️  Parsed ${valid.length} files (${allPaths.length - valid.length} skipped)`);

    this.db.transaction(() => {
      for (const result of valid) {
        this.db.upsertFile(result.file);
        for (const section of result.sections) {
          this.db.insertSection(section);
        }
        if (result.facts.length > 0) this.db.insertFacts(result.facts);
        if (result.entities.length > 0) this.db.insertEntities(result.entities);
      }
    });

    onProgress?.('🔗 Building syntactic dependency edges...');
    this.buildSyntacticEdges(valid);

    onProgress?.('🧠 Extracting concepts (AI consensus)...');
    let conceptCount = 0;
    const aiLimit = pLimit(4);
    await Promise.all(
      valid.map((result) =>
        aiLimit(async () => {
          const count = await this.extractAndStoreConcepts(result);
          conceptCount += count;
        })
      )
    );

    onProgress?.(`💡 Extracted ${conceptCount} concepts`);
    onProgress?.('⛓️  Building semantic edges + validating chains...');

    this.buildSemanticEdges();
    const brokenCount = this.validateAllChains();

    const durationMs = Date.now() - startMs;
    onProgress?.(`✅ Scan complete in ${durationMs}ms`);

    const summary = this.db.getChainHealthSummary();
    return {
      filesIndexed: valid.length,
      conceptsFound: conceptCount,
      edgesCreated: summary.totalEdges,
      brokenChains: brokenCount,
      durationMs,
    };
  }

  // ─── Incremental Re-Index ─────────────────────────────────────────────────────

  async incrementalScan(changedPaths: AbsPath[]): Promise<IncrementalResult> {
    const startMs = Date.now();
    const results: ParseResult[] = [];

    for (const path of changedPaths) {
      const result = parseFile(path);
      if (!result) continue;

      const existing = this.db.getFileByPath(path);
      if (existing) {
        if (existing.contentHash === result.file.contentHash) continue; // unchanged
        this.db.deleteFileData(existing.id);
      }

      this.db.transaction(() => {
        this.db.upsertFile(result.file);
        for (const section of result.sections) {
          this.db.insertSection(section);
        }
        if (result.facts.length > 0) this.db.insertFacts(result.facts);
        if (result.entities.length > 0) this.db.insertEntities(result.entities);
      });

      results.push(result);
    }

    if (results.length === 0) {
      return { reindexed: 0, brokenChains: 0, impactedSections: 0, durationMs: Date.now() - startMs };
    }

    this.buildSyntacticEdges(results);
    for (const result of results) {
      await this.extractAndStoreConcepts(result);
    }
    this.buildSemanticEdges();
    const brokenChains = this.validateAllChains();

    return {
      reindexed: results.length,
      brokenChains,
      impactedSections: 0,
      durationMs: Date.now() - startMs,
    };
  }

  // ─── Syntactic Edge Builder ───────────────────────────────────────────────────

  private buildSyntacticEdges(parseResults: ParseResult[]): void {
    const exportMap = new Map<string, Hash[]>();

    for (const result of parseResults) {
      for (const fact of result.facts) {
        if (fact.kind === 'export') {
          const existing = exportMap.get(fact.symbol) ?? [];
          existing.push(fact.sectionId);
          exportMap.set(fact.symbol, existing);
        }
      }
    }

    for (const result of parseResults) {
      for (const fact of result.facts) {
        if (fact.kind === 'import') {
          const targets = exportMap.get(fact.symbol);
          if (targets) {
            for (const targetSectionId of targets) {
              if (targetSectionId === fact.sectionId) continue;
              const edge: Edge = {
                id: `${fact.sectionId}:${targetSectionId}:SYNTACTIC_IMPORT` as Hash,
                fromId: fact.sectionId,
                toId: targetSectionId,
                edgeType: 'SYNTACTIC_IMPORT',
                weight: 1.0,
                evidence: {
                  reason: `Section imports "${fact.symbol}"`,
                  symbol: fact.symbol,
                  lineRef: fact.lineStart,
                  sourceAnalysis: 'ast',
                },
                createdAt: Date.now(),
              };
              this.db.insertEdge(edge);
            }
          }
        }
      }
    }

    // Cross-file structural entity overlap → SYNTACTIC_REFERENCE / POLICY_GOVERNS edges
    const allEntities = parseResults.flatMap((r) => r.entities);
    const entityByNormalized = new Map<string, StructuralEntity[]>();
    for (const entity of allEntities) {
      const key = `${entity.kind}:${entity.normalized}`;
      const existing = entityByNormalized.get(key) ?? [];
      existing.push(entity);
      entityByNormalized.set(key, existing);
    }

    for (const entities of entityByNormalized.values()) {
      if (entities.length < 2) continue;
      for (let i = 0; i < entities.length; i++) {
        for (let j = i + 1; j < entities.length; j++) {
          const a = entities[i]!;
          const b = entities[j]!;
          if (a.fileId === b.fileId) continue;

          const edgeType: EdgeType = a.kind === 'policy_term' ? 'POLICY_GOVERNS' : 'SYNTACTIC_REFERENCE';
          const edge: Edge = {
            id: `${a.sectionId}:${b.sectionId}:${edgeType}` as Hash,
            fromId: a.sectionId,
            toId: b.sectionId,
            edgeType,
            weight: edgeWeight(edgeType, 'STRUCTURAL'),
            evidence: {
              reason: `Both sections reference structural entity: ${a.normalized}`,
              symbol: a.normalized,
              lineRef: a.lineStart,
              sourceAnalysis: 'structural_entity',
            },
            createdAt: Date.now(),
          };
          this.db.insertEdge(edge);
        }
      }
    }
  }

  // ─── Concept Extraction + Chain Building ──────────────────────────────────────

  private async extractAndStoreConcepts(result: ParseResult): Promise<number> {
    let count = 0;

    for (const section of result.sections) {
      const sectionEntities = result.entities.filter((e) => e.sectionId === section.id);
      const structuralLabels = sectionEntities.map((e) => e.normalized as ConceptLabel);

      const rawConcepts = await extractConcepts(
        section.rawText,
        structuralLabels,
        {
          geminiApiKey: this.config.ai.geminiApiKey,
          localModel: this.config.ai.localModel !== 'none' ? this.config.ai.localModel : null,
          requireConsensus: this.config.ai.consensusRequired,
        }
      );

      const now = Date.now();
      for (const raw of rawConcepts) {
        const cId = makeConceptId(section.rawText, raw.label, section.fileId);
        const secHash = section.contentHash;
        const chainLinkHash = buildChainLink(cId, null, secHash);

        const concept: Concept = {
          id: cId,
          label: raw.label,
          canonical: normalizeForFingerprint(section.rawText).slice(0, 500),
          sectionId: section.id,
          fileId: section.fileId,
          confidence: raw.confidence,
          chainLink: chainLinkHash,
          chainState: 'VALID',
          brokenAt: null,
          ackAt: null,
          ackBy: null,
          createdAt: now,
          updatedAt: now,
        };

        this.db.upsertConcept(concept);
        count++;
      }
    }

    return count;
  }

  // ─── Semantic Edge Builder ────────────────────────────────────────────────────

  private buildSemanticEdges(): void {
    const allFiles = this.db.getAllFiles();
    const labelToSections = new Map<string, Array<{ sectionId: Hash; fileId: Hash; confidence: string }>>();

    for (const file of allFiles) {
      const sections = this.db.getSectionsForFile(file.id);
      for (const section of sections) {
        const concepts = this.db.getConceptsForSection(section.id);
        for (const concept of concepts) {
          const existing = labelToSections.get(concept.label) ?? [];
          existing.push({ sectionId: section.id, fileId: file.id, confidence: concept.confidence });
          labelToSections.set(concept.label, existing);
        }
      }
    }

    for (const [label, sections] of labelToSections) {
      if (sections.length < 2) continue;

      for (let i = 0; i < sections.length; i++) {
        for (let j = i + 1; j < sections.length; j++) {
          const a = sections[i]!;
          const b = sections[j]!;
          if (a.fileId === b.fileId) continue;

          const confidence = (a.confidence === 'STRUCTURAL' || b.confidence === 'STRUCTURAL')
            ? 'STRUCTURAL'
            : (a.confidence === 'CONSENSUS' && b.confidence === 'CONSENSUS')
              ? 'CONSENSUS'
              : 'SINGLE_MODEL';

          const edge: Edge = {
            id: `${a.sectionId}:${b.sectionId}:CONCEPT_SHARED:${label}` as Hash,
            fromId: a.sectionId,
            toId: b.sectionId,
            edgeType: 'CONCEPT_SHARED',
            weight: edgeWeight('CONCEPT_SHARED', confidence as Concept['confidence']),
            evidence: {
              reason: `Both sections encode concept: "${label}"`,
              symbol: label,
              sourceAnalysis: confidence === 'STRUCTURAL' ? 'structural_entity' : 'consensus_ai',
            },
            createdAt: Date.now(),
          };
          this.db.insertEdge(edge);
        }
      }
    }
  }

  // ─── Chain Validation ─────────────────────────────────────────────────────────

  private validateAllChains(): number {
    let brokenCount = 0;
    const allFiles = this.db.getAllFiles();

    for (const file of allFiles) {
      const sections = this.db.getSectionsForFile(file.id);
      for (const section of sections) {
        const concepts = this.db.getConceptsForSection(section.id);
        if (concepts.length === 0) continue;

        const currentHash = sectionHash(section.rawText);

        for (const concept of concepts) {
          const isValid = validateChainLink(
            {
              conceptId: concept.id,
              sectionHash: currentHash,
              chainLink: concept.chainLink,
              parentChainLink: null,
              state: concept.chainState,
              brokenAt: concept.brokenAt ?? null,
              acknowledgedAt: concept.ackAt ?? null,
              acknowledgedBy: concept.ackBy ?? null,
            },
            currentHash,
          );

          if (!isValid && concept.chainState === 'VALID') {
            this.db.upsertConcept({
              ...concept,
              chainState: 'CHAIN_BROKEN',
              brokenAt: Date.now(),
              updatedAt: Date.now(),
            });
            this.db.appendAudit({
              eventType: 'CHAIN_BROKEN',
              sectionId: section.id,
              conceptId: concept.id,
              ruleId: null,
              oldHash: concept.chainLink,
              newHash: currentHash,
              timestampMs: Date.now(),
              actor: 'indexer',
              meta: { label: concept.label, filePath: file.path },
            });
            brokenCount++;
          }
        }
      }
    }

    return brokenCount;
  }

  // ─── Impact Analysis ──────────────────────────────────────────────────────────

  getImpactMap(changedPaths: AbsPath[]) {
    const changedSectionIds: Hash[] = [];

    for (const path of changedPaths) {
      const file = this.db.getFileByPath(path);
      if (!file) continue;
      const sections = this.db.getSectionsForFile(file.id);
      changedSectionIds.push(...sections.map((s) => s.id));
    }

    if (changedSectionIds.length === 0) {
      return { changedFiles: changedPaths, impacted: [], brokenChains: [], total: 0 };
    }

    const blastRadius = this.db.getBlastRadius(changedSectionIds, this.config.gatekeeper.maxDepth);
    const brokenConcepts = this.db.getBrokenConcepts();

    return {
      changedFiles: changedPaths,
      impacted: blastRadius,
      brokenChains: brokenConcepts,
      total: blastRadius.length,
    };
  }

  /**
   * Get broken chains for specific changed files, enriched with location info.
   * Used by CLI `check` command and MCP `engine_validate`.
   */
  getBrokenForFiles(changedPaths: AbsPath[]): BrokenChainEntry[] {
    const result: BrokenChainEntry[] = [];

    for (const path of changedPaths) {
      const file = this.db.getFileByPath(path);
      if (!file) continue;

      // 1. Broken concepts directly in changed files (JOIN query, no N+1)
      const brokenInFile = this.db.getBrokenConceptsForFileWithLocations(file.id);
      for (const concept of brokenInFile) {
        result.push({
          conceptId: concept.id,
          conceptLabel: concept.label,
          filePath: concept.filePath,
          fileId: file.id,
          sectionId: concept.sectionId,
          lineStart: concept.lineStart,
          lineEnd: concept.lineEnd,
          severity: 'HIGH',
          chainLink: concept.chainLink,
          confidence: concept.confidence,
          reason: `Concept "${concept.label}" chain broken — upstream content changed`,
        });
      }

      // 2. Downstream blast radius — stale sections in OTHER files
      const sections = this.db.getSectionsForFile(file.id);
      const sectionIds = sections.map((s) => s.id);
      if (sectionIds.length > 0) {
        const blastRadius = this.db.getBlastRadius(sectionIds, this.config.gatekeeper.maxDepth);
        for (const impacted of blastRadius) {
          if (impacted.chainState !== 'CHAIN_BROKEN') continue;
          const sev = impactSeverity(impacted.edgeType, impacted.chainState);
          result.push({
            conceptId: '' as Hash,
            conceptLabel: `[via ${impacted.edgeType}]`,
            filePath: impacted.filePath,
            fileId: impacted.fileId,
            sectionId: impacted.sectionId,
            lineStart: impacted.lineStart,
            lineEnd: impacted.lineEnd,
            severity: sev,
            chainLink: '' as Hash,
            confidence: 'STRUCTURAL',
            reason: `Downstream dependency via ${impacted.edgeType} (depth ${impacted.depth})`,
          });
        }
      }
    }

    // Deduplicate by sectionId
    const seen = new Set<string>();
    return result.filter((r) => {
      if (seen.has(r.sectionId)) return false;
      seen.add(r.sectionId);
      return true;
    });
  }

  /**
   * Get ALL broken chains across the project with location enrichment.
   * Used by CLI `status --broken` and `review`.
   */
  getAllBrokenChains(): BrokenChainEntry[] {
    // Single JOIN query — no N+1
    const brokenWithLocs = this.db.getBrokenConceptsWithLocations();
    return brokenWithLocs.map((concept) => ({
      conceptId: concept.id,
      conceptLabel: concept.label,
      filePath: concept.filePath,
      fileId: concept.fileId,
      sectionId: concept.sectionId,
      lineStart: concept.lineStart,
      lineEnd: concept.lineEnd,
      severity: 'HIGH' as ImpactSeverity,
      chainLink: concept.chainLink,
      confidence: concept.confidence,
      reason: `Concept "${concept.label}" chain link is broken`,
    }));
  }

  /**
   * Acknowledge a broken chain — marks it as ACKNOWLEDGED_DRIFT.
   * Creates an immutable audit entry.
   */
  acknowledgeBrokenChain(conceptId: Hash, actor: string): void {
    const allFiles = this.db.getAllFiles();
    for (const file of allFiles) {
      const concepts = this.db.getBrokenConceptsForFile(file.id);
      for (const concept of concepts) {
        if (concept.id !== conceptId) continue;
        this.db.upsertConcept({
          ...concept,
          chainState: 'ACKNOWLEDGED_DRIFT',
          ackAt: Date.now(),
          ackBy: actor,
          updatedAt: Date.now(),
        });
        this.db.appendAudit({
          eventType: 'CHAIN_ACKNOWLEDGED',
          sectionId: concept.sectionId,
          conceptId: concept.id,
          ruleId: null,
          oldHash: concept.chainLink,
          newHash: null,
          timestampMs: Date.now(),
          actor,
          meta: { label: concept.label, reason: 'acknowledged via CLI/MCP' },
        });
        return;
      }
    }
  }

  /**
   * Resolve a broken chain — marks it as VALID after user confirms fix.
   * Forces re-hash of the section and rebuilds chain link.
   */
  resolveBrokenChain(conceptId: Hash): void {
    const allFiles = this.db.getAllFiles();
    for (const file of allFiles) {
      const sections = this.db.getSectionsForFile(file.id);
      for (const section of sections) {
        const concepts = this.db.getConceptsForSection(section.id);
        for (const concept of concepts) {
          if (concept.id !== conceptId) continue;
          // Recompute chain link from current section content
          const newSecHash = sectionHash(section.rawText);
          const newChainLink = buildChainLink(concept.id, null, newSecHash);
          this.db.upsertConcept({
            ...concept,
            chainState: 'VALID',
            chainLink: newChainLink,
            brokenAt: null,
            ackAt: null,
            ackBy: null,
            updatedAt: Date.now(),
          });
          this.db.appendAudit({
            eventType: 'CHAIN_RESOLVED',
            sectionId: section.id,
            conceptId: concept.id,
            ruleId: null,
            oldHash: concept.chainLink,
            newHash: newChainLink,
            timestampMs: Date.now(),
            actor: 'cli',
            meta: { label: concept.label },
          });
          return;
        }
      }
    }
  }

  // ─── Public Accessors ─────────────────────────────────────────────────────────

  getHealthSummary() {
    return this.db.getChainHealthSummary();
  }

  queryConceptLocations(label: string) {
    return this.db.getConceptLocations(label);
  }
}
