/**
 * Structural Entity Extractor — Agent-Only Governance
 *
 * Deterministic standard regex/keyword threshold parsers have been completely
 * removed to align with a pure Agent-Brain framework.
 *
 * Returns zero structural entities, relying wholly on explicit decisions and
 * binds established by the active Agent.
 */

import type { StructuralEntity, Hash } from '../types/index.js';

export interface ExtractionInput {
  text: string;
  sectionId: Hash;
  fileId: Hash;
  lineStart: number;
  fileKind?: string;
}

export function extractStructuralEntities(input: ExtractionInput): StructuralEntity[] {
  return [];
}
