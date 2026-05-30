/**
 * @engine/core — Public API
 *
 * Everything exported from this package.
 */

// Types
export * from './types/index.js';

// Chain fingerprinting
export {
  hash,
  hashBytes,
  fileId,
  sectionId,
  conceptId,
  sectionHash,
  buildChainLink,
  validateChainLink,
  recomputeChainLink,
  normalizeForFingerprint,
  edgeWeight,
  impactSeverity,
  computeChainState,
} from './chain/fingerprint.js';

// Database
export { GraphDB } from './db/graph.js';

// Parsers
export { parseFile, detectFileKind } from './parser/chunker.js';
export { extractStructuralEntities, findStructuralOverlap } from './parser/structural.js';

// AI
export { extractConcepts, generateEmbedding } from './ai/extractor.js';
export type { RawConceptResult, ConceptExtractionConfig } from './ai/extractor.js';

// Indexer
export { Indexer } from './indexer.js';
export type { ScanResult, IncrementalResult, BrokenChainEntry } from './indexer.js';
