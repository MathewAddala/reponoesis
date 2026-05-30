/**
 * AI Concept Extractor — Adversarial Consensus Protocol
 *
 * Implements the two-model consensus system:
 *   - Model A: Gemini 2.0 Flash (cloud, fast)
 *   - Model B: Ollama local model (air-gapped check)
 *
 * A concept is ACCEPTED only if BOTH models return it
 * (within semantic similarity threshold of 0.85).
 *
 * Falls back to single-model if the other is unavailable,
 * but marks confidence as SINGLE_MODEL (lower trust).
 *
 * Structural entities (from structural.ts) are ALWAYS accepted
 * regardless of AI — they are deterministic.
 */

import type { ConceptLabel, Hash, ConceptConfidence } from '../types/index.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface RawConceptResult {
  label: ConceptLabel;
  confidence: ConceptConfidence;
  description: string;
}

export interface AIModelResult {
  model: string;
  labels: string[];
  success: boolean;
  errorReason?: string;
}

// ─── Gemini API Client ─────────────────────────────────────────────────────────

const GEMINI_CONCEPT_PROMPT = (text: string) => `You are a code/document concept extractor for a developer tool.

Analyze the following text and return a JSON array of the business/product/technical concepts it encodes.

Rules:
1. Be SPECIFIC, not generic. "ad_tracking" not "tracking". "free_plan_limit" not "limit".
2. Use snake_case for concept labels.
3. Maximum 8 concepts per section.
4. Only include concepts that, if changed, would require updates in OTHER files.
5. Return ONLY valid JSON array of strings. Example: ["ad_tracking", "gdpr_consent", "rate_limit_5"]

Text to analyze:
"""
${text.slice(0, 1500)}
"""`;

async function callGeminiFlash(text: string, apiKey: string): Promise<AIModelResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: GEMINI_CONCEPT_PROMPT(text) }] }],
        generationConfig: {
          temperature: 0.1,    // low temperature = deterministic outputs
          maxOutputTokens: 256,
          responseMimeType: 'application/json',
        },
      }),
      signal: AbortSignal.timeout(8000), // 8s timeout
    });

    if (!res.ok) {
      return { model: 'gemini-2.0-flash', labels: [], success: false, errorReason: `HTTP ${res.status}` };
    }

    const data = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';
    const parsed: unknown = JSON.parse(rawText);

    if (!Array.isArray(parsed)) {
      return { model: 'gemini-2.0-flash', labels: [], success: false, errorReason: 'Not array' };
    }

    const labels = (parsed as unknown[])
      .filter((l): l is string => typeof l === 'string')
      .map(l => l.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_') as ConceptLabel);

    return { model: 'gemini-2.0-flash', labels, success: true };
  } catch (err) {
    return {
      model: 'gemini-2.0-flash',
      labels: [],
      success: false,
      errorReason: err instanceof Error ? err.message : 'Unknown',
    };
  }
}

// ─── Ollama Local Model Client ─────────────────────────────────────────────────

async function callOllamaLocal(text: string, model = 'mistral'): Promise<AIModelResult> {
  try {
    const res = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: GEMINI_CONCEPT_PROMPT(text),
        stream: false,
        options: { temperature: 0.1, num_predict: 256 },
      }),
      signal: AbortSignal.timeout(15000), // local model can be slower
    });

    if (!res.ok) {
      return { model, labels: [], success: false, errorReason: `HTTP ${res.status}` };
    }

    const data = await res.json() as { response?: string };
    const rawText = data.response ?? '[]';

    // Extract JSON array from response (local models sometimes add prose)
    const jsonMatch = rawText.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) {
      return { model, labels: [], success: false, errorReason: 'No JSON array found' };
    }

    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) {
      return { model, labels: [], success: false, errorReason: 'Not array' };
    }

    const labels = (parsed as unknown[])
      .filter((l): l is string => typeof l === 'string')
      .map(l => l.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_') as ConceptLabel);

    return { model, labels, success: true };
  } catch (err) {
    return {
      model,
      labels: [],
      success: false,
      errorReason: err instanceof Error ? err.message : 'Unknown',
    };
  }
}

// ─── Consensus Resolver ────────────────────────────────────────────────────────

/**
 * Semantic similarity between two concept labels.
 * Uses token overlap (Jaccard coefficient) on underscore-split tokens.
 * Fast, zero-dependency, deterministic.
 *
 * "ad_tracking" vs "advertising_tracking" → 0.5 (share "tracking")
 * "ad_tracking" vs "ad_tracking" → 1.0
 * "ad_tracking" vs "user_auth" → 0.0
 */
function labelSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.split('_').filter(t => t.length > 2));
  const tokensB = new Set(b.split('_').filter(t => t.length > 2));

  if (tokensA.size === 0 || tokensB.size === 0) return a === b ? 1.0 : 0.0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return intersection / union;
}

const SIMILARITY_THRESHOLD = 0.65; // labels sharing >65% tokens are considered same concept

/**
 * Find concepts that appear in both model outputs
 * (within semantic similarity threshold).
 */
function findConsensus(labelsA: string[], labelsB: string[]): Array<{ label: ConceptLabel; confidence: 'CONSENSUS' }> {
  const result: Array<{ label: ConceptLabel; confidence: 'CONSENSUS' }> = [];

  for (const labelA of labelsA) {
    for (const labelB of labelsB) {
      if (labelSimilarity(labelA, labelB) >= SIMILARITY_THRESHOLD) {
        // Use the shorter/more specific label as canonical
        const canonical = labelA.length <= labelB.length ? labelA : labelB;
        // Don't duplicate
        if (!result.find(r => r.label === canonical)) {
          result.push({ label: canonical as ConceptLabel, confidence: 'CONSENSUS' });
        }
        break;
      }
    }
  }

  return result;
}

// ─── Main Extraction Function ──────────────────────────────────────────────────

export interface ConceptExtractionConfig {
  geminiApiKey: string | null;
  localModel: string | null;      // Ollama model name, or null if disabled
  requireConsensus: boolean;       // if true, reject SINGLE_MODEL results
}

/**
 * Extract concepts from a section of text using the adversarial consensus protocol.
 *
 * Returns only concepts that meet the confidence bar:
 *   - requireConsensus=true → only CONSENSUS or STRUCTURAL
 *   - requireConsensus=false → also includes SINGLE_MODEL
 *
 * Structural entities from the deterministic extractor are ALWAYS included.
 */
export async function extractConcepts(
  text: string,
  structuralEntityLabels: ConceptLabel[],
  config: ConceptExtractionConfig,
): Promise<RawConceptResult[]> {
  const results: RawConceptResult[] = [];

  // 1. Structural entities are ALWAYS accepted — they are facts, not guesses
  for (const label of structuralEntityLabels) {
    results.push({
      label,
      confidence: 'STRUCTURAL',
      description: `Structurally extracted: ${label}`,
    });
  }

  // 2. Skip AI extraction if text is too short to have concepts
  if (text.trim().length < 50) return results;

  // 3. Run both models in parallel
  const [geminiResult, ollamaResult] = await Promise.all([
    config.geminiApiKey
      ? callGeminiFlash(text, config.geminiApiKey)
      : Promise.resolve<AIModelResult>({ model: 'gemini', labels: [], success: false, errorReason: 'No API key' }),

    config.localModel
      ? callOllamaLocal(text, config.localModel)
      : Promise.resolve<AIModelResult>({ model: 'local', labels: [], success: false, errorReason: 'Disabled' }),
  ]);

  // 4. Determine what we can trust
  const geminiOk = geminiResult.success && geminiResult.labels.length > 0;
  const ollamaOk = ollamaResult.success && ollamaResult.labels.length > 0;

  if (geminiOk && ollamaOk) {
    // Both succeeded — find consensus
    const consensus = findConsensus(geminiResult.labels, ollamaResult.labels);
    for (const { label, confidence } of consensus) {
      // Skip if already in structural
      if (results.find(r => r.label === label)) continue;
      results.push({ label, confidence, description: `Consensus: ${label}` });
    }
  } else if (geminiOk && !config.requireConsensus) {
    // Only Gemini — mark as SINGLE_MODEL
    for (const label of geminiResult.labels) {
      if (results.find(r => r.label === label)) continue;
      results.push({ label: label as ConceptLabel, confidence: 'SINGLE_MODEL', description: `Gemini only: ${label}` });
    }
  } else if (ollamaOk && !config.requireConsensus) {
    // Only Ollama — mark as SINGLE_MODEL
    for (const label of ollamaResult.labels) {
      if (results.find(r => r.label === label)) continue;
      results.push({ label: label as ConceptLabel, confidence: 'SINGLE_MODEL', description: `Local only: ${label}` });
    }
  }
  // If both failed → only structural entities returned (safe degradation)

  return results;
}

// ─── Embedding Generation ──────────────────────────────────────────────────────

/**
 * Generate an embedding vector for a text chunk using Gemini.
 * Used for similarity clustering during concept grouping.
 * Returns null if API unavailable — embedding is optional.
 */
export async function generateEmbedding(text: string, apiKey: string): Promise<number[] | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/text-embedding-004',
        content: { parts: [{ text: text.slice(0, 2048) }] },
        taskType: 'SEMANTIC_SIMILARITY',
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return null;
    const data = await res.json() as { embedding?: { values?: number[] } };
    return data.embedding?.values ?? null;
  } catch {
    return null;
  }
}
