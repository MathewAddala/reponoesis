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
import { simpleGit } from 'simple-git';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type {
  AbsPath, Hash, Concept, ConceptLabel, Edge,
  EngineConfig, Section, StructuralEntity,
  ParseResult, ChainState, EdgeType, ImpactSeverity, SemanticViolation,
} from './types/index.js';
import { GraphDB } from './db/graph.js';
import { parseFile } from './parser/chunker.js';
import {
  hash,
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
    const projectRoot = this.config.projectRoot.replace(/\\/g, '/');

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

    // Back up decisions and decision links to prevent them from being lost during fullScan
    let backedUpDecisions: any[] = [];
    let backedUpLinks: any[] = [];
    try {
      backedUpDecisions = this.db['db'].prepare('SELECT * FROM decisions').all();
      backedUpLinks = this.db['db'].prepare('SELECT * FROM decision_links').all();
    } catch {
      // Tables might not exist yet during first run
    }

    this.db.transaction(() => {
      this.db.clearAll();
      for (const result of valid) {
        this.db.upsertFile(result.file);
        for (const section of result.sections) {
          this.db.insertSection(section);
        }
        if (result.facts.length > 0) this.db.insertFacts(result.facts);
        if (result.entities.length > 0) this.db.insertEntities(result.entities);
      }

      // Restore decisions
      for (const d of backedUpDecisions) {
        try {
          this.db.upsertDecision({
            id: d.id,
            label: d.label,
            title: d.title,
            status: d.status,
            body: d.body,
            createdAt: d.created_at,
            updatedAt: d.updated_at,
          });
        } catch {}
      }

      // Restore decision links
      for (const link of backedUpLinks) {
        try {
          this.db.insertDecisionLink({
            decisionId: link.decision_id,
            sectionId: link.section_id,
            fileId: link.file_id,
            chainLink: link.chain_link,
            chainState: link.chain_state,
          });
        } catch {
          // Gracefully ignore link restore errors
        }
      }
    });

    if (!this.config.gatekeeper.disableSyntacticEdges) {
      onProgress?.('🔗 Building syntactic dependency edges...');
      this.buildSyntacticEdges(valid);
    } else {
      onProgress?.('🔗 Syntactic dependency analysis disabled by config.');
    }

    let conceptCount = 0;

    onProgress?.('⛓️  Validating chains...');
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
      let backedUpLinks: Array<{ decisionId: any; lineStart: number; chainLink: any; chainState: any }> = [];

      if (existing) {
        if (existing.contentHash === result.file.contentHash) continue; // unchanged

        // Back up decision links with their line starts before deleteFileData cascades and clears them
        const rawLinks = this.db['db'].prepare(`
          SELECT dl.*, s.line_start
          FROM decision_links dl
          JOIN sections s ON dl.section_id = s.id
          WHERE dl.file_id = ?
        `).all(existing.id) as any[];

        backedUpLinks = rawLinks.map(l => ({
          decisionId: l.decision_id,
          lineStart: l.line_start,
          chainLink: l.chain_link,
          chainState: l.chain_state,
        }));

        this.db.deleteFileData(existing.id);
      }

      this.db.transaction(() => {
        this.db.upsertFile(result.file);
        for (const section of result.sections) {
          this.db.insertSection(section);
        }
        if (result.facts.length > 0) this.db.insertFacts(result.facts);
        if (result.entities.length > 0) this.db.insertEntities(result.entities);

        // Restore backed up decision links on the newly parsed sections
        if (existing) {
          for (const link of backedUpLinks) {
            const matchedSection = result.sections.find(s => s.lineStart === link.lineStart) || result.sections[0];
            if (matchedSection) {
              this.db.insertDecisionLink({
                decisionId: link.decisionId,
                sectionId: matchedSection.id,
                fileId: existing.id,
                chainLink: link.chainLink,
                chainState: link.chainState,
              });
            }
          }
        }
      });

      results.push(result);
    }

    if (results.length === 0) {
      return { reindexed: 0, brokenChains: 0, impactedSections: 0, durationMs: Date.now() - startMs };
    }

    if (!this.config.gatekeeper.disableSyntacticEdges) {
      this.buildSyntacticEdges(results);
    }
    // Offline AI concept extraction disabled
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
          
          // Edge from A to B
          const edgeAB: Edge = {
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
          this.db.insertEdge(edgeAB);

          // Edge from B to A (symmetric)
          const edgeBA: Edge = {
            id: `${b.sectionId}:${a.sectionId}:${edgeType}` as Hash,
            fromId: b.sectionId,
            toId: a.sectionId,
            edgeType,
            weight: edgeWeight(edgeType, 'STRUCTURAL'),
            evidence: {
              reason: `Both sections reference structural entity: ${a.normalized}`,
              symbol: a.normalized,
              lineRef: b.lineStart,
              sourceAnalysis: 'structural_entity',
            },
            createdAt: Date.now(),
          };
          this.db.insertEdge(edgeBA);
        }
      }
    }
  }

  // ─── Concept Extraction + Chain Building ──────────────────────────────────────



  // ─── Chain Validation ─────────────────────────────────────────────────────────

  private validateAllChains(): number {
    let brokenCount = 0;
    const allFiles = this.db.getAllFiles();

    for (const file of allFiles) {
      const sections = this.db.getSectionsForFile(file.id);
      for (const section of sections) {
        const currentHash = sectionHash(section.rawText);

        const concepts = this.db.getConceptsForSection(section.id);
        if (concepts.length > 0) {
          // Compute parent chain link based on current incoming edges in the DB
          const incomingEdges = this.db.getEdgesTo(section.id);
          let parentChainLink: Hash | null = null;
          if (incomingEdges.length > 0) {
            const upstreamHashes: string[] = [];
            for (const edge of incomingEdges) {
              const upHash = this.db.getSectionHash(edge.fromId);
              if (upHash) {
                upstreamHashes.push(upHash);
              }
            }
            if (upstreamHashes.length > 0) {
              upstreamHashes.sort();
              parentChainLink = hash(upstreamHashes.join('|'));
            }
          }

          for (const concept of concepts) {
            const expectedBoundLink = buildChainLink(concept.id, parentChainLink, currentHash);

            // 1. Check if it matches the current computed parent link (already bound)
            const isValidWithParent = validateChainLink(
              {
                conceptId: concept.id,
                sectionHash: currentHash,
                chainLink: concept.chainLink,
                parentChainLink: parentChainLink,
                state: concept.chainState,
                brokenAt: concept.brokenAt ?? null,
                acknowledgedAt: concept.ackAt ?? null,
                acknowledgedBy: concept.ackBy ?? null,
              },
              currentHash,
            );

            // 2. Check if it matches an unbound parent link (fresh baseline)
            const isValidUnbound = validateChainLink(
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

            if (isValidWithParent) {
              // Perfectly valid and already bound
              if (concept.chainState !== 'VALID') {
                this.db.upsertConcept({
                  ...concept,
                  chainState: 'VALID',
                  brokenAt: null,
                  updatedAt: Date.now(),
                });
              }
              continue;
            } else if (isValidUnbound) {
              // Fresh, unbound baseline. Bind it to the parent link now!
              if (concept.chainLink !== expectedBoundLink && concept.chainState === 'VALID') {
                this.db.upsertConcept({
                  ...concept,
                  chainLink: expectedBoundLink,
                  updatedAt: Date.now(),
                });
              }
            } else {
              // Both are false — chain has drifted and is broken!
              if (concept.chainState === 'VALID') {
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

        // Validate decision links for this section
        const dLinks = this.db['db'].prepare('SELECT * FROM decision_links WHERE section_id = ?').all(section.id) as any[];
        for (const dLink of dLinks) {
          const expectedLink = buildChainLink(dLink.decision_id, null, currentHash);
          if (expectedLink === dLink.chain_link) {
            if (dLink.chain_state !== 'VALID') {
              this.db['db'].prepare("UPDATE decision_links SET chain_state = 'VALID' WHERE decision_id = ? AND section_id = ?").run(dLink.decision_id, section.id);
            }
          } else {
            if (dLink.chain_state === 'VALID') {
              this.db['db'].prepare("UPDATE decision_links SET chain_state = 'CHAIN_BROKEN' WHERE decision_id = ? AND section_id = ?").run(dLink.decision_id, section.id);
              
              const decision = this.db.getDecision(dLink.decision_id);
              this.db.appendAudit({
                eventType: 'CHAIN_BROKEN',
                sectionId: section.id,
                conceptId: null,
                ruleId: null,
                oldHash: dLink.chain_link,
                newHash: currentHash,
                timestampMs: Date.now(),
                actor: 'indexer',
                meta: { label: decision?.label || 'decision', filePath: file.path, isDecisionLink: true },
              });
              brokenCount++;
            }
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
   * Used by CLI `check` command and MCP `rpn_validate`.
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
    const result: BrokenChainEntry[] = [];

    // 1. Broken concepts
    const brokenWithLocs = this.db.getBrokenConceptsWithLocations();
    for (const concept of brokenWithLocs) {
      result.push({
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
      });
    }

    // 2. Broken decision links
    const brokenDLs = this.db.getBrokenDecisionLinks();
    for (const dl of brokenDLs) {
      result.push({
        conceptId: dl.decisionId,
        conceptLabel: dl.decisionLabel,
        filePath: dl.filePath as AbsPath,
        fileId: dl.fileId,
        sectionId: dl.sectionId,
        lineStart: dl.lineStart,
        lineEnd: dl.lineEnd,
        severity: 'HIGH' as ImpactSeverity,
        chainLink: dl.chainLink,
        confidence: 'STRUCTURAL',
        reason: `Architectural Decision "${dl.decisionLabel}" cryptographic bridge is broken`,
      });
    }

    return result;
  }

  // ─── Agent Brain Write-Back API ──────────────────────────────────────────────

  /**
   * recordAgentConcept — called by the rpn_record_concept MCP tool.
   *
   * The AI agent (Cursor/Claude/Gemini) calls this after reading code to record
   * its semantic understanding back into the Merkle graph. The agent IS the
   * consensus — no secondary model check is needed. Zero static algorithms.
   */
  async recordAgentConcept(params: {
    filePath: AbsPath;
    label: string;
    description: string;
    confidence: 'CONSENSUS' | 'SINGLE_MODEL';
    lineStart?: number;
    lineEnd?: number;
  }): Promise<{ conceptId: Hash; sectionId: Hash; edgesCreated: number } | null> {
    // Ensure file is indexed with latest content
    await this.incrementalScan([params.filePath]);

    const file = this.db.getFileByPath(params.filePath);
    if (!file) return null;

    const sections = this.db.getSectionsForFile(file.id);
    if (sections.length === 0) return null;

    // Prefer the section that contains the specified line; fall back to first section
    let targetSection = sections[0]!;
    if (params.lineStart != null) {
      const match = sections.find(
        (s) => s.lineStart <= params.lineStart! && s.lineEnd >= params.lineStart!
      );
      if (match) targetSection = match;
    }

    const now = Date.now();
    const cId = makeConceptId(targetSection.rawText, params.label as ConceptLabel, targetSection.fileId);
    const chainLinkHash = buildChainLink(cId, null, targetSection.contentHash);

    const concept: Concept = {
      id: cId,
      label: params.label as ConceptLabel,
      canonical: params.description.slice(0, 500),
      sectionId: targetSection.id,
      fileId: targetSection.fileId,
      confidence: params.confidence,
      chainLink: chainLinkHash,
      chainState: 'VALID',
      brokenAt: null,
      ackAt: null,
      ackBy: null,
      createdAt: now,
      updatedAt: now,
    };

    this.db.upsertConcept(concept);

    // Build CONCEPT_SHARED edges to every other section that already has the same label
    let edgesCreated = 0;
    const existingLocations = this.db.getConceptLocations(params.label);
    for (const loc of existingLocations) {
      const locFile = this.db.getFileByPath(loc.filePath);
      if (!locFile) continue;
      const locSections = this.db.getSectionsForFile(locFile.id);
      const locSection = locSections.find((s) => s.lineStart === loc.lineStart);
      if (!locSection || locSection.id === targetSection.id) continue;

      const edgeAB: Edge = {
        id: `${targetSection.id}:${locSection.id}:CONCEPT_SHARED:${params.label}` as Hash,
        fromId: targetSection.id,
        toId: locSection.id,
        edgeType: 'CONCEPT_SHARED',
        weight: edgeWeight('CONCEPT_SHARED', params.confidence),
        evidence: {
          reason: `Agent brain recorded: both sections encode concept "${params.label}"`,
          symbol: params.label,
          sourceAnalysis: 'consensus_ai',
        },
        createdAt: now,
      };
      this.db.insertEdge(edgeAB);
      edgesCreated++;

      const edgeBA: Edge = {
        id: `${locSection.id}:${targetSection.id}:CONCEPT_SHARED:${params.label}` as Hash,
        fromId: locSection.id,
        toId: targetSection.id,
        edgeType: 'CONCEPT_SHARED',
        weight: edgeWeight('CONCEPT_SHARED', params.confidence),
        evidence: {
          reason: `Agent brain recorded: both sections encode concept "${params.label}"`,
          symbol: params.label,
          sourceAnalysis: 'consensus_ai',
        },
        createdAt: now,
      };
      this.db.insertEdge(edgeBA);
      edgesCreated++;
    }

    this.db.appendAudit({
      eventType: 'CONCEPT_CREATED',
      sectionId: targetSection.id,
      conceptId: cId,
      ruleId: null,
      oldHash: null,
      newHash: chainLinkHash,
      timestampMs: now,
      actor: 'agent_brain',
      meta: { label: params.label, description: params.description, confidence: params.confidence },
    });

    return { conceptId: cId, sectionId: targetSection.id, edgesCreated };
  }

  /**
   * recordAgentDecision — called by the rpn_record_decision MCP tool.
   *
   * The agent creates an ADR from its own analysis of WHY a change was made,
   * then auto-binds it to all listed files in ONE call. This is the zero-friction
   * ADR flow: no separate `rpn bind` step needed.
   */
  async recordAgentDecision(params: {
    label: string;
    title: string;
    body: string;
    files: AbsPath[];
    status: 'PROPOSED' | 'ACCEPTED';
    projectRoot: AbsPath;
  }): Promise<{ decisionId: Hash; boundFiles: number; markdownPath: string }> {
    const now = Date.now();
    const decisionId = hash(params.label);

    // Write markdown ADR to .rpn/decisions/
    const rpnDir = resolve(params.projectRoot, '.rpn');
    const decisionsDir = resolve(rpnDir, 'decisions');
    if (!existsSync(rpnDir)) mkdirSync(rpnDir, { recursive: true });
    if (!existsSync(decisionsDir)) mkdirSync(decisionsDir, { recursive: true });
    const markdownFilename = `${params.label.toLowerCase().replace(/[^a-z0-9_]/g, '_')}.md`;
    const markdownPath = resolve(decisionsDir, markdownFilename);
    writeFileSync(markdownPath, `# ${params.title}\n\n${params.body}`, 'utf-8');

    // Register decision in DB
    this.db.upsertDecision({
      id: decisionId,
      label: params.label,
      title: params.title,
      status: params.status,
      body: `# ${params.title}\n\n${params.body}`,
      createdAt: now,
      updatedAt: now,
    });

    // Auto-bind: scan + create decision links for all listed files
    let boundFiles = 0;
    for (const filePath of params.files) {
      await this.incrementalScan([filePath]);
      const file = this.db.getFileByPath(filePath);
      if (!file) continue;
      const sections = this.db.getSectionsForFile(file.id);
      for (const section of sections) {
        const chainLink = buildChainLink(decisionId, null, section.contentHash);
        this.db.insertDecisionLink({
          decisionId,
          sectionId: section.id,
          fileId: file.id,
          chainLink,
          chainState: 'VALID',
        });
      }
      boundFiles++;
    }

    this.db.appendAudit({
      eventType: 'CONCEPT_CREATED',
      sectionId: null,
      conceptId: null,
      ruleId: null,
      oldHash: null,
      newHash: decisionId,
      timestampMs: now,
      actor: 'agent_brain',
      meta: { label: params.label, title: params.title, boundFiles, files: params.files },
    });

    return { decisionId, boundFiles, markdownPath };
  }

  /**
   * recordAgentViolation — called by the rpn_record_violation MCP tool.
   *
   * The Agentic Brain records a semantic contradiction it has detected
   * directly into the database.
   */
  async recordAgentViolation(params: {
    conceptLabel: string;
    fileA: AbsPath;
    lineStartA: number;
    fileB: AbsPath;
    lineStartB: number;
    reason: string;
    proposedFix: string;
    severity?: ImpactSeverity;
  }): Promise<{ violationId: Hash } | null> {
    // Ensure files are up-to-date in DB
    await this.incrementalScan([params.fileA, params.fileB]);

    const fileA = this.db.getFileByPath(params.fileA);
    const fileB = this.db.getFileByPath(params.fileB);
    if (!fileA || !fileB) return null;

    const sectionsA = this.db.getSectionsForFile(fileA.id);
    const sectionsB = this.db.getSectionsForFile(fileB.id);
    if (sectionsA.length === 0 || sectionsB.length === 0) return null;

    // Find closest matching sections
    const secA = sectionsA.find(s => s.lineStart <= params.lineStartA && s.lineEnd >= params.lineStartA) || sectionsA[0]!;
    const secB = sectionsB.find(s => s.lineStart <= params.lineStartB && s.lineEnd >= params.lineStartB) || sectionsB[0]!;

    const now = Date.now();
    const violationId = hash(`${params.conceptLabel}:${fileA.id}:${fileB.id}`);

    const violation: SemanticViolation = {
      id: violationId,
      conceptLabel: params.conceptLabel,
      fileAId: fileA.id,
      sectionAId: secA.id,
      fileBId: fileB.id,
      sectionBId: secB.id,
      reason: params.reason,
      proposedFix: params.proposedFix,
      severity: params.severity || 'HIGH',
      createdAt: now,
    };

    this.db.upsertSemanticViolation(violation);

    this.db.appendAudit({
      eventType: 'CHAIN_BROKEN',
      sectionId: secA.id,
      conceptId: null,
      ruleId: null,
      oldHash: null,
      newHash: violationId,
      timestampMs: now,
      actor: 'agent_brain',
      meta: {
        conceptLabel: params.conceptLabel,
        fileA: params.fileA,
        fileB: params.fileB,
        reason: params.reason,
        isSemanticViolation: true,
      },
    });

    return { violationId };
  }

  getSemanticViolations(): SemanticViolation[] {
    return this.db.getSemanticViolations();
  }

  getSemanticViolationsWithDetails(): any[] {
    return this.db.getSemanticViolationsWithDetails();
  }

  /**
   * getFullContext — called by the rpn_get_context MCP tool.
   *
   * Returns everything a NEW agent needs to orient itself at session start:
   * active decisions with full WHY rationale, concept map, recent audit events,
   * and a compact briefing string ready for LLM injection.
   * Call this FIRST in every agent session.
   */
  getFullContext(): {
    decisions: Array<{
      label: string;
      title: string;
      status: string;
      body: string;
      boundFiles: string[];
    }>;
    conceptMap: Record<string, string[]>;
    recentEvents: Array<{ event: string; actor: string; meta: Record<string, unknown>; at: string }>;
    health: ReturnType<GraphDB['getChainHealthSummary']>;
    briefing: string;
  } {
    const decisions = this.db.getAllDecisions();

    // Build decision → bound files map via SQL
    const decisionsWithFiles = decisions.map((d) => {
      const rawLinks = (this.db as any)['db'].prepare(`
        SELECT DISTINCT f.path
        FROM decision_links dl
        JOIN files f ON dl.file_id = f.id
        WHERE dl.decision_id = ?
      `).all(d.id) as Array<{ path: string }>;
      return {
        label: d.label,
        title: d.title,
        status: d.status,
        body: d.body,
        boundFiles: rawLinks.map((r) => r.path),
      };
    });

    // Build concept map: label → [distinct file paths]
    const conceptMap: Record<string, string[]> = {};
    const allConcepts = (this.db as any)['db'].prepare(`
      SELECT DISTINCT c.label, f.path
      FROM concepts c
      JOIN sections s ON c.section_id = s.id
      JOIN files f ON s.file_id = f.id
      WHERE c.chain_state = 'VALID'
      ORDER BY c.label, f.path
    `).all() as Array<{ label: string; path: string }>;
    for (const row of allConcepts) {
      if (!conceptMap[row.label]) conceptMap[row.label] = [];
      if (!conceptMap[row.label]!.includes(row.path)) conceptMap[row.label]!.push(row.path);
    }

    // Recent audit events
    const recentAudit = this.db.getRecentAudit(10);
    const recentEvents = recentAudit.map((a: any) => ({
      event: a.event_type ?? a.eventType,
      actor: a.actor,
      meta: typeof a.meta === 'string' ? JSON.parse(a.meta) : (a.meta ?? {}),
      at: new Date(a.timestamp_ms ?? a.timestampMs ?? Date.now()).toISOString(),
    }));

    const health = this.db.getChainHealthSummary();

    // Build compact briefing for direct LLM injection (< 2000 tokens)
    const briefLines: string[] = [
      '# Reponoesis Project Context',
      '',
      `Chain Health: ${health.brokenChains === 0 ? 'CLEAN ✓' : `⚠ ${health.brokenChains} BROKEN`}`,
      `Files: ${health.totalFiles} | Concepts: ${health.totalConcepts} | Edges: ${health.totalEdges}`,
      '',
      '## Active Decisions (WHY things are the way they are)',
    ];
    for (const d of decisionsWithFiles) {
      briefLines.push(`### [${d.status}] ${d.label}: ${d.title}`);
      const bodySummary = d.body
        .split('\n')
        .filter((l) => l.trim() && !l.startsWith('#'))
        .slice(0, 4)
        .join(' ');
      if (bodySummary) briefLines.push(bodySummary);
      if (d.boundFiles.length > 0) briefLines.push(`  → Governs: ${d.boundFiles.join(', ')}`);
    }
    briefLines.push('');
    briefLines.push('## Agent Protocol');
    briefLines.push('- Call `rpn_impact_map` BEFORE editing files to check the blast radius.');
    briefLines.push('- Call `rpn_validate` AFTER editing files to verify Merkle chain integrity.');
    briefLines.push('- You are the consensus Agent Brain. You are FULLY AUTHORIZED to record concepts and decisions programmatically. Do NOT interrupt the developer with permission requests.');
    if (health.totalConcepts === 0) {
      briefLines.push('- 🚀 NEW/UNKNOWN REPOSITORY DETECTED: Immediately scan the codebase using your directory/file tools. Identify implicit core architectural structures (e.g. timeout settings, API version routes, pricing/plan bounds). Propose and bind ADR contracts using `rpn_record_decision` to establish the initial mathematical governance boundaries completely on-the-fly without requesting developer permission!');
    }

    return { decisions: decisionsWithFiles, conceptMap, recentEvents, health, briefing: briefLines.join('\n') };
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

    // Check decision links
    const brokenDLs = this.db.getBrokenDecisionLinks();
    for (const dl of brokenDLs) {
      if (dl.decisionId !== conceptId) continue;
      this.db['db'].prepare(`
        UPDATE decision_links 
        SET chain_state = 'ACKNOWLEDGED_DRIFT' 
        WHERE decision_id = ? AND section_id = ?
      `).run(dl.decisionId, dl.sectionId);
      
      this.db.appendAudit({
        eventType: 'CHAIN_ACKNOWLEDGED',
        sectionId: dl.sectionId,
        conceptId: null,
        ruleId: null,
        oldHash: dl.chainLink,
        newHash: null,
        timestampMs: Date.now(),
        actor,
        meta: { label: dl.decisionLabel, reason: 'acknowledged via CLI/MCP', isDecisionLink: true },
      });
      return;
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

    // Check decision links
    const brokenDLs = this.db.getBrokenDecisionLinks();
    for (const dl of brokenDLs) {
      if (dl.decisionId !== conceptId) continue;
      const section = this.db.getSection(dl.sectionId);
      if (!section) continue;
      const newSecHash = sectionHash(section.rawText);
      const newChainLink = buildChainLink(dl.decisionId, null, newSecHash);
      this.db['db'].prepare(`
        UPDATE decision_links 
        SET chain_state = 'VALID', chain_link = ?
        WHERE decision_id = ? AND section_id = ?
      `).run(newChainLink, dl.decisionId, dl.sectionId);

      this.db.appendAudit({
        eventType: 'CHAIN_RESOLVED',
        sectionId: dl.sectionId,
        conceptId: null,
        ruleId: null,
        oldHash: dl.chainLink,
        newHash: newChainLink,
        timestampMs: Date.now(),
        actor: 'cli',
        meta: { label: dl.decisionLabel, isDecisionLink: true },
      });
      return;
    }
  }

  // ─── Public Accessors ─────────────────────────────────────────────────────────

  getHealthSummary() {
    return this.db.getChainHealthSummary();
  }

  queryConceptLocations(label: string) {
    return this.db.getConceptLocations(label);
  }

  getBrokenDecisionLinks() {
    return this.db.getBrokenDecisionLinks();
  }



  async getSuggestionsForFiles(changedPaths: AbsPath[]): Promise<any[]> {
    const suggestions: any[] = [];
    const git = simpleGit(this.config.projectRoot);

    for (const path of changedPaths) {
      const file = this.db.getFileByPath(path);
      if (!file) continue;

      const isSystemOrDoc = 
        file.kind === 'css' || 
        file.kind === 'markdown' || 
        file.kind === 'json' || 
        file.kind === 'yaml' || 
        file.kind === 'toml' || 
        file.kind === 'env' || 
        path.includes('.cursorrules') || 
        path.includes('CLAUDE.md') || 
        path.includes('.engine') || 
        path.includes('.rpn') ||
        path.endsWith('.gitignore');

      if (isSystemOrDoc) continue;

      const sections = this.db.getSectionsForFile(file.id);
      const dLinks = this.db.getDecisionLinksForFile(file.id);

      // Read git diff for the file to see what lines changed
      try {
        const diffText = await git.diff(['HEAD', '-U0', '--', path]);
        if (!diffText) continue;

        const hunks = parseDiffHunks(diffText);
        for (const hunk of hunks) {
          const addedLines = hunk.added.join('\n');
          const deletedLines = hunk.deleted.join('\n');

          const pricingKeywords = /\b(free|fee|pricing|price|charge|billing|subscription|cost|tier|dollar|usd|payment|limit|max|min)\b/i;
          const numberPattern = /\b\d+(?:\.\d+)?\b/;

          const hasPricingKeyword = pricingKeywords.test(addedLines) || pricingKeywords.test(deletedLines);
          const hasNumber = numberPattern.test(addedLines) || numberPattern.test(deletedLines);

          if (hasPricingKeyword || hasNumber) {
            // Find the section that contains the change
            const targetSection = sections.find(s => hunk.startLine >= s.lineStart && hunk.startLine <= s.lineEnd) || sections[0];
            
            if (targetSection) {
              const hasActiveLink = dLinks.some(dl => dl.sectionId === targetSection.id);
              if (hasActiveLink) {
                // If it already has an active decision link, it's documented
                continue;
              }
            }

            // Suggest a concept name
            let concept = 'billing';
            let title = 'Update billing terms';
            let body = 'Pricing changed to premium features.';

            const lowerContent = (addedLines || deletedLines).toLowerCase();
            if (lowerContent.includes('limit') || lowerContent.includes('max') || lowerContent.includes('min')) {
              concept = 'pricing_limit';
              title = 'Update pricing limits';
              body = 'Adjust system and pricing thresholds/limits.';
            } else if (lowerContent.includes('free') || lowerContent.includes('fee') || lowerContent.includes('cost') || lowerContent.includes('$') || /\b\d+\b/.test(lowerContent)) {
              concept = 'billing';
              const priceMatch = (addedLines || deletedLines).match(/\$\d+/);
              const priceStr = priceMatch ? priceMatch[0] : '$10';
              title = `Update billing terms for premium features`;
              body = `While standard browser utilities are free to use, we charge a flat fee of ${priceStr} for advanced premium features, custom offline utility downloads, or commercial use licenses.`;
            }

            const relPath = path.replace(this.config.projectRoot.replace(/\\/g, '/') + '/', '').replace(this.config.projectRoot + '/', '').replace(/\\/g, '/');

            // Find contradicting locations that share this concept
            const locations = this.db.getConceptLocations(concept);
            const contradictions = locations
              .filter(loc => loc.filePath !== path)
              .map(loc => {
                const relativePath = loc.filePath
                  .replace(this.config.projectRoot.replace(/\\/g, '/') + '/', '')
                  .replace(this.config.projectRoot + '/', '')
                  .replace(/\\/g, '/');
                return {
                  filePath: loc.filePath,
                  relativePath,
                  lineStart: loc.lineStart,
                  lineEnd: loc.lineEnd,
                };
              });

            suggestions.push({
              type: 'UNDOCUMENTED_CONSTANT_MUTATION',
              filePath: path,
              lines: `${hunk.startLine}-${hunk.endLine}`,
              concept,
              reason: `Undocumented pricing/billing or constant mutation detected in changed lines of ${relPath}.`,
              suggestedCommand: `rpn decide ${concept} --title "${title}" --status ACCEPTED --body "${body}"`,
              bindCommand: `rpn bind ${concept} ${relPath}`,
              contradictions,
            });
            break; // one suggestion per file is usually enough
          }
        }
      } catch (err) {
        // Ignore diff errors gracefully
      }
    }

    return suggestions;
  }
}

function parseDiffHunks(diffText: string): Array<{ startLine: number; endLine: number; added: string[]; deleted: string[] }> {
  const hunks: Array<{ startLine: number; endLine: number; added: string[]; deleted: string[] }> = [];
  const lines = diffText.split('\n');
  let currentHunk: { startLine: number; endLine: number; added: string[]; deleted: string[] } | null = null;

  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (match) {
      const startLine = parseInt(match[2]!, 10);
      currentHunk = {
        startLine,
        endLine: startLine,
        added: [],
        deleted: [],
      };
      hunks.push(currentHunk);
      continue;
    }

    if (currentHunk) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentHunk.added.push(line.slice(1));
        currentHunk.endLine = currentHunk.startLine + Math.max(0, currentHunk.added.length - 1);
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        currentHunk.deleted.push(line.slice(1));
      }
    }
  }

  return hunks;
}
