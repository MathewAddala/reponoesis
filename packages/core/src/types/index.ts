/**
 * @engine/core — Master Type Definitions
 *
 * Every type used across the engine lives here.
 * Zero `any`. Zero `unknown` without guards.
 * Rename prefix "@engine" → your product name before release.
 */

// ─── Identity Types ────────────────────────────────────────────────────────────

/** SHA3-256 hex string — 64 chars */
export type Hash = string & { readonly __brand: 'Hash' };

/** Absolute filesystem path */
export type AbsPath = string & { readonly __brand: 'AbsPath' };

/** Unique concept label, snake_case e.g. "ad_tracking" */
export type ConceptLabel = string & { readonly __brand: 'ConceptLabel' };

// ─── File & Section ────────────────────────────────────────────────────────────

export type FileKind =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'json'
  | 'yaml'
  | 'toml'
  | 'markdown'
  | 'html'
  | 'css'
  | 'env'
  | 'text'
  | 'unknown';

export interface FileRecord {
  id: Hash;               // SHA3-256(absolutePath)
  path: AbsPath;
  kind: FileKind;
  contentHash: Hash;      // SHA3-256(raw file bytes)
  mtimeMs: number;
  indexedAt: number;      // unix ms
  sectionCount: number;
}

export type SectionKind =
  | 'code_function'
  | 'code_class'
  | 'code_module'
  | 'code_config'
  | 'doc_heading'
  | 'doc_paragraph'
  | 'doc_codeblock'
  | 'legal_clause'
  | 'config_block'
  | 'template_block'
  | 'env_block'
  | 'unknown_block';

export interface Section {
  id: Hash;               // SHA3-256(fileId + lineStart + lineEnd)
  fileId: Hash;
  filePath: AbsPath;
  lineStart: number;
  lineEnd: number;
  contentHash: Hash;      // SHA3-256(raw section text)
  rawText: string;        // actual content (stored for analysis)
  kind: SectionKind;
}

// ─── Syntactic Facts (deterministic, zero AI) ──────────────────────────────────

export type SyntacticFactKind =
  | 'import'
  | 'export'
  | 'function_call'
  | 'type_reference'
  | 'string_literal'
  | 'numeric_literal'
  | 'env_var_reference'
  | 'route_definition'
  | 'schema_field'
  | 'comment_reference'
  | 'url_literal'
  | 'regex_pattern';

export interface SyntacticFact {
  kind: SyntacticFactKind;
  symbol: string;         // the extracted symbol/value
  scope: string;          // function/class/module context
  lineStart: number;
  lineEnd: number;
  sectionId: Hash;
  fileId: Hash;
}

// ─── Structural Entities (NLP-extracted, deterministic) ────────────────────────

export type EntityKind =
  | 'feature_flag'        // e.g., AD_TRACKING_ENABLED
  | 'numeric_threshold'   // e.g., FREE_PLAN_LIMIT = 5
  | 'product_name'        // e.g., "Pro Plan"
  | 'url_endpoint'        // e.g., /api/v2/users
  | 'email_address'
  | 'role_name'           // e.g., "admin", "editor"
  | 'sdk_reference'       // e.g., "Google Analytics", "Stripe"
  | 'policy_term'         // e.g., "GDPR", "CCPA"
  | 'env_variable'        // e.g., DATABASE_URL
  | 'named_constant';     // any ALL_CAPS identifier

export interface StructuralEntity {
  kind: EntityKind;
  value: string;          // raw extracted value
  normalized: string;     // lowercased, underscored canonical form
  sectionId: Hash;
  fileId: Hash;
  lineStart: number;
  confidence: 1.0;        // always 1.0 — structural is deterministic
}

// ─── Concepts (AI-extracted, consensus-verified) ───────────────────────────────

export type ConceptConfidence = 'STRUCTURAL' | 'CONSENSUS' | 'SINGLE_MODEL';

export interface Concept {
  id: Hash;               // ConceptID = SHA3-256(canonical + label + scope)
  label: ConceptLabel;
  canonical: string;      // normalized concept description
  sectionId: Hash;
  fileId: Hash;
  confidence: ConceptConfidence;
  // Chain
  chainLink: Hash;        // SHA3-256(conceptId + parentChainLink + sectionHash)
  chainState: ChainState;
  // Chain audit fields
  brokenAt?: number | null;
  ackAt?: number | null;
  ackBy?: string | null;
  // Timestamps
  createdAt: number;
  updatedAt: number;
}

// ─── Business Rules ────────────────────────────────────────────────────────────

export interface BusinessRule {
  id: Hash;               // SHA3-256(label + initial definition source)
  label: string;          // e.g., "free_plan_project_limit"
  value: string | null;   // e.g., "5" if numeric
  description: string;
  createdAt: number;
}

export interface RuleInstance {
  ruleId: Hash;
  sectionId: Hash;
  fileId: Hash;
  encodedAs: 'constant' | 'string_literal' | 'prose_statement' | 'config_value';
  rawValue: string | null;
  chainLink: Hash;
  chainState: ChainState;
}

// ─── Concept Merkle Chain ──────────────────────────────────────────────────────

export type ChainState = 'VALID' | 'CHAIN_BROKEN' | 'ACKNOWLEDGED_DRIFT';

export interface ChainLink {
  conceptId: Hash;
  sectionHash: Hash;      // hash of section content at time of link creation
  chainLink: Hash;        // the cryptographic binding
  parentChainLink: Hash | null;  // null = root node
  state: ChainState;
  brokenAt: number | null;       // unix ms when chain was broken
  acknowledgedAt: number | null;
  acknowledgedBy: string | null; // 'pre-commit' | 'mcp' | 'manual'
}

// ─── Dependency Graph Edges ────────────────────────────────────────────────────

export type EdgeType =
  // Deterministic (weight = 1.0, always)
  | 'SYNTACTIC_IMPORT'
  | 'SYNTACTIC_CALL'
  | 'SYNTACTIC_REFERENCE'
  | 'DATA_FLOW'
  | 'ENV_VAR_REFERENCE'
  | 'SCHEMA_FIELD_USE'
  | 'ROUTE_CONSUMER'
  // Consensus AI (weight = 0.85-1.0)
  | 'CONCEPT_SHARED'
  | 'RULE_INSTANCE'
  // Policy / Legal (consensus AI + structural)
  | 'POLICY_GOVERNS'
  | 'CONTENT_REFERENCES';

export interface Edge {
  id: Hash;
  fromId: Hash;           // section id
  toId: Hash;             // section id
  edgeType: EdgeType;
  weight: number;         // 0.0–1.0 (structural always 1.0)
  evidence: EdgeEvidence;
  createdAt: number;
}

export interface EdgeEvidence {
  reason: string;
  symbol?: string;        // the shared symbol/concept
  lineRef?: number;
  sourceAnalysis: 'ast' | 'cfg' | 'dfg' | 'consensus_ai' | 'structural_entity';
}

// ─── Audit Log ─────────────────────────────────────────────────────────────────

export type AuditEventType =
  | 'FILE_INDEXED'
  | 'CONCEPT_CREATED'
  | 'CHAIN_BROKEN'
  | 'CHAIN_ACKNOWLEDGED'
  | 'CHAIN_RESOLVED'
  | 'RULE_CREATED'
  | 'RULE_BROKEN'
  | 'EDGE_CREATED'
  | 'SCAN_COMPLETE';

export interface AuditEntry {
  id?: number;            // auto-increment
  eventType: AuditEventType;
  sectionId: Hash | null;
  conceptId: Hash | null;
  ruleId: Hash | null;
  oldHash: Hash | null;
  newHash: Hash | null;
  timestampMs: number;
  actor: string;          // 'pre-commit' | 'mcp' | 'cli' | 'watcher'
  meta: Record<string, unknown>;
}

// ─── Impact Analysis Results ───────────────────────────────────────────────────

export type ImpactSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface ImpactNode {
  section: Section;
  severity: ImpactSeverity;
  reason: string;
  edgeType: EdgeType;
  depth: number;          // how many hops from the changed file
  chainState: ChainState;
}

export interface ImpactMap {
  changedFiles: AbsPath[];
  directSyntactic: ImpactNode[];   // will definitely break (imports, types)
  semanticShared: ImpactNode[];    // share concept — review required
  ruleInstances: ImpactNode[];     // encode same business rule
  policyGoverned: ImpactNode[];    // legal/policy files
  brokenChains: ChainLink[];       // cryptographic mismatches
  totalImpacted: number;
  scanDurationMs: number;
}

// ─── Engine Config ─────────────────────────────────────────────────────────────

export interface EngineConfig {
  projectRoot: AbsPath;
  dbPath: AbsPath;           // default: .engine/graph.db
  ignorePaths: string[];     // glob patterns
  enabledParsers: FileKind[];
  ai: {
    primaryModel: 'gemini-2.0-flash' | 'gemini-1.5-flash' | 'none';
    localModel: 'mistral' | 'llama3' | 'none';   // via Ollama
    geminiApiKey: string | null;
    consensusRequired: boolean;  // require 2-model agreement
    embeddingModel: 'text-embedding-004' | 'none';
  };
  gatekeeper: {
    blockOnCritical: boolean;
    blockOnHigh: boolean;
    warnOnMedium: boolean;
    maxDepth: number;        // max graph traversal depth
  };
}

// ─── Parser Output ─────────────────────────────────────────────────────────────

export interface ParseResult {
  file: FileRecord;
  sections: Section[];
  facts: SyntacticFact[];
  entities: StructuralEntity[];
}
