/**
 * Concept Merkle Chain — Cryptographic fingerprinting
 *
 * This is the "no gap, binding chain of bits" layer.
 * Every dependency link is a SHA3-256 hash. If the upstream
 * content changes, the downstream chain link becomes invalid
 * deterministically — no threshold, no fuzzy score, pure math.
 */

import jsSha3 from 'js-sha3';
const { sha3_256 } = jsSha3;
import type { Hash, ConceptLabel, AbsPath, ChainLink, ChainState } from '../types/index.js';

// ─── Hash Utilities ────────────────────────────────────────────────────────────

/**
 * Core hash function. Returns a branded Hash type.
 * Using SHA3-256 (Keccak variant) — not SHA-256.
 * SHA3 is resistant to length-extension attacks and is used
 * in Ethereum, NIST post-quantum standards.
 */
export function hash(input: string): Hash {
  return sha3_256(input) as Hash;
}

/**
 * Hash raw bytes (Buffer or Uint8Array).
 * Used for file content hashing.
 */
export function hashBytes(input: Uint8Array | Buffer): Hash {
  return sha3_256(input) as Hash;
}

/**
 * Hash a file path to create a stable, unique file ID.
 * Normalized to forward slashes + lowercased for cross-platform consistency.
 */
export function fileId(absolutePath: AbsPath): Hash {
  const normalized = absolutePath.replace(/\\/g, '/').toLowerCase();
  return hash(`file:${normalized}`);
}

/**
 * Hash a section within a file.
 * Incorporates file ID + line range for uniqueness.
 */
export function sectionId(fId: Hash, lineStart: number, lineEnd: number): Hash {
  return hash(`section:${fId}:${lineStart}:${lineEnd}`);
}

// ─── Concept Fingerprinting ────────────────────────────────────────────────────

/**
 * Normalize text for concept fingerprinting.
 *
 * Minor whitespace changes, comment reformatting, or line ending
 * differences should NOT invalidate a concept. We normalize to
 * produce a stable canonical form.
 */
export function normalizeForFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/\r\n/g, '\n')           // normalize line endings
    .replace(/\t/g, '  ')             // tabs → spaces
    .replace(/[ ]{2,}/g, ' ')         // collapse multiple spaces
    .replace(/\/\/.*/g, '')           // strip // comments
    .replace(/\/\*[\s\S]*?\*\//g, '') // strip /* */ comments
    .replace(/\s+/g, ' ')             // collapse all whitespace
    .trim();
}

/**
 * Generate a stable ConceptID.
 *
 * ConceptID = SHA3-256(canonical_text | concept_label | file_scope)
 *
 * This ID is STABLE across minor text reformatting — it only changes
 * when the actual conceptual meaning changes (different canonical form
 * or different label).
 */
export function conceptId(
  sectionText: string,
  label: ConceptLabel,
  fileScope: string,   // e.g., function name, class name, or file path
): Hash {
  const canonical = normalizeForFingerprint(sectionText);
  return hash(`concept:${canonical}|${label}|${fileScope}`);
}

/**
 * Generate a SectionHash — a direct hash of the raw content.
 * This WILL change on any edit, including whitespace.
 * Used to detect that content changed (triggers chain revalidation).
 */
export function sectionHash(rawText: string): Hash {
  return hash(`raw:${rawText}`);
}

// ─── Chain Link Construction ───────────────────────────────────────────────────

/**
 * Build a chain link — the cryptographic binding between a concept and its chain.
 *
 * ChainLink = SHA3-256(conceptId | parentChainLink | sectionHash)
 *
 * If ANY of:
 *   - the concept itself changes (conceptId changes)
 *   - the parent concept changes (parentChainLink changes)
 *   - the raw content changes (sectionHash changes)
 * → the ChainLink hash changes → the dependency is detected as broken
 *
 * This is analogous to a git tree hash or a certificate chain signature.
 */
export function buildChainLink(
  cId: Hash,
  parentChainLink: Hash | null,
  secHash: Hash,
): Hash {
  const parentPart = parentChainLink ?? 'ROOT';
  return hash(`chain:${cId}|${parentPart}|${secHash}`);
}

/**
 * Validate a stored chain link against the current state.
 *
 * Returns true if the chain is INTACT, false if BROKEN.
 * This is deterministic — no threshold, no confidence score.
 */
export function validateChainLink(stored: ChainLink, currentSectionHash: Hash): boolean {
  const expected = buildChainLink(
    stored.conceptId,
    stored.parentChainLink,
    currentSectionHash,
  );
  return expected === stored.chainLink;
}

/**
 * Compute the new chain link for a section after its content changed.
 * Used during re-indexing to update stored chain links.
 */
export function recomputeChainLink(
  stored: ChainLink,
  newSectionHash: Hash,
): Hash {
  return buildChainLink(stored.conceptId, stored.parentChainLink, newSectionHash);
}

// ─── Chain State Machine ────────────────────────────────────────────────────────

/**
 * Determine what chain state a link should be in given validation results.
 *
 * State machine:
 *   VALID → (upstream changes) → CHAIN_BROKEN
 *   CHAIN_BROKEN → (user acknowledges) → ACKNOWLEDGED_DRIFT
 *   CHAIN_BROKEN → (user fixes + rescan) → VALID
 *   ACKNOWLEDGED_DRIFT → (new scan confirms fix) → VALID
 */
export function computeChainState(
  isValid: boolean,
  currentState: ChainState,
  wasAcknowledged: boolean,
): ChainState {
  if (isValid) return 'VALID';
  if (wasAcknowledged) return 'ACKNOWLEDGED_DRIFT';
  return 'CHAIN_BROKEN';
}

// ─── Edge Weight ───────────────────────────────────────────────────────────────

import type { EdgeType } from '../types/index.js';

/**
 * Assign a deterministic weight to an edge type.
 * Structural/syntactic = 1.0 always.
 * AI-derived = 0.85–0.95 depending on confidence.
 * Weight is used for display priority, not for filtering
 * (all broken chains are reported regardless of weight).
 */
export function edgeWeight(type: EdgeType, confidence?: 'STRUCTURAL' | 'CONSENSUS' | 'SINGLE_MODEL'): number {
  switch (type) {
    case 'SYNTACTIC_IMPORT':
    case 'SYNTACTIC_CALL':
    case 'SYNTACTIC_REFERENCE':
    case 'DATA_FLOW':
    case 'ENV_VAR_REFERENCE':
    case 'SCHEMA_FIELD_USE':
    case 'ROUTE_CONSUMER':
      return 1.0; // deterministic, always

    case 'RULE_INSTANCE':
      return confidence === 'STRUCTURAL' ? 1.0 : 0.92;

    case 'CONCEPT_SHARED':
      return confidence === 'CONSENSUS' ? 0.90 : 0.70;

    case 'POLICY_GOVERNS':
      return confidence === 'STRUCTURAL' ? 0.95 : 0.85;

    case 'CONTENT_REFERENCES':
      return confidence === 'CONSENSUS' ? 0.85 : 0.65;

    default:
      return 0.5;
  }
}

// ─── Severity Mapping ──────────────────────────────────────────────────────────

import type { ImpactSeverity } from '../types/index.js';

/**
 * Map an edge type + chain state to an impact severity.
 * Used in the gatekeeper to decide whether to block a commit.
 */
export function impactSeverity(edgeType: EdgeType, chainState: ChainState): ImpactSeverity {
  if (chainState === 'VALID') return 'LOW';

  switch (edgeType) {
    case 'SYNTACTIC_IMPORT':
    case 'SYNTACTIC_CALL':
    case 'DATA_FLOW':
      return 'CRITICAL';

    case 'RULE_INSTANCE':
    case 'POLICY_GOVERNS':
    case 'SCHEMA_FIELD_USE':
    case 'ROUTE_CONSUMER':
      return 'HIGH';

    case 'CONCEPT_SHARED':
    case 'ENV_VAR_REFERENCE':
      return 'MEDIUM';

    case 'CONTENT_REFERENCES':
    case 'SYNTACTIC_REFERENCE':
      return 'LOW';

    default:
      return 'LOW';
  }
}
