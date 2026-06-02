/**
 * AI Concept Extractor — Agent-Only Governance
 *
 * This extractor has been modified to operate wholly in the local active AI Agent
 * environment. Background headless model consensus checks and local heuristic 
 * fallbacks have been completely eliminated.
 *
 * Concepts are resolved 100% deterministically from structural AST entities and
 * governed programmatically by the developer agent via explicit decision binds.
 */

import type { ConceptLabel, ConceptConfidence } from '../types/index.js';

export interface RawConceptResult {
  label: ConceptLabel;
  confidence: ConceptConfidence;
  description: string;
}

export interface ConceptExtractionConfig {
  geminiApiKey: string | null;
  localModel: string | null;
  requireConsensus: boolean;
}

/**
 * Extract concepts from a section of text.
 * Governed strictly by standard AST structural entities in the active Agent environment.
 */
export async function extractConcepts(
  text: string,
  structuralEntityLabels: ConceptLabel[],
  config: ConceptExtractionConfig,
): Promise<RawConceptResult[]> {
  const results: RawConceptResult[] = [];

  // Structural entities are ALWAYS accepted — they represent actual facts
  for (const label of structuralEntityLabels) {
    results.push({
      label,
      confidence: 'STRUCTURAL',
      description: `Structurally extracted: ${label}`,
    });
  }

  return results;
}

/**
 * Headless embedding generation disabled.
 */
export async function generateEmbedding(text: string, apiKey: string): Promise<number[] | null> {
  return null;
}
