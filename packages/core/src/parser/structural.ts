/**
 * Structural Entity Extractor
 *
 * Deterministic extraction of named entities from any text.
 * Zero AI — pure regex + pattern matching.
 * Output confidence is ALWAYS 1.0 (deterministic).
 *
 * What we extract:
 *   - Feature flags (ALL_CAPS_IDENTIFIERS, env vars)
 *   - Numeric thresholds (limits, quotas, rates)
 *   - SDK/library names (Google Analytics, Stripe, etc.)
 *   - Product/role names (Pro Plan, admin, editor)
 *   - URLs and API endpoints
 *   - Policy terms (GDPR, CCPA, HIPAA)
 *   - Environment variables ($VAR, process.env.VAR)
 */

import type { StructuralEntity, EntityKind, Hash } from '../types/index.js';
import { hash } from '../chain/fingerprint.js';

// ─── Extraction Patterns ───────────────────────────────────────────────────────

// Feature flags & constants: ALL_CAPS with optional underscores, min 3 chars
const FEATURE_FLAG_RE = /\b([A-Z][A-Z0-9_]{2,})\b/g;

// Numeric thresholds: number + optional unit near a context word
const NUMERIC_THRESHOLD_RE = /(?:limit|max|min|quota|rate|count|size|length|threshold|period|days?|hours?|minutes?|seconds?|ms|kb|mb|gb)\s*[=:]\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:limit|max|min|quota|rate|count|size|length|threshold|days?|hours?|minutes?|seconds?|ms|kb|mb|gb)/gi;

// Environment variables: process.env.X, $X, ${X}, import.meta.env.X
const ENV_VAR_RE = /(?:process\.env\.|import\.meta\.env\.|Deno\.env\.get\(["']|\$\{?|os\.environ\[["']|os\.getenv\(["'])([A-Z][A-Z0-9_]{1,})/g;

// API endpoints: /path/to/resource patterns
const ROUTE_RE = /["'`](\/(api|v\d+|graphql|webhook|auth|oauth)\/[a-zA-Z0-9/:_-]+)["'`]/g;

// URLs: http/https with meaningful paths (not just bare domains)
const URL_RE = /https?:\/\/[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._~:/?#[\]@!$&'()*+,;=%-]*)?/g;

// Known SDK/platform names — exact match list (extensible)
const SDK_NAMES: ReadonlyArray<[RegExp, string]> = [
  [/\bGoogle Analytics\b/gi, 'google_analytics'],
  [/\bGA4\b/g, 'google_analytics_4'],
  [/\bFirebase\b/gi, 'firebase'],
  [/\bStripe\b/gi, 'stripe'],
  [/\bTwilio\b/gi, 'twilio'],
  [/\bSendGrid\b/gi, 'sendgrid'],
  [/\bIntercom\b/gi, 'intercom'],
  [/\bSegment\b/gi, 'segment'],
  [/\bAmplitude\b/gi, 'amplitude'],
  [/\bMixpanel\b/gi, 'mixpanel'],
  [/\bDatadog\b/gi, 'datadog'],
  [/\bSentry\b/gi, 'sentry'],
  [/\bHotjar\b/gi, 'hotjar'],
  [/\bFullStory\b/gi, 'fullstory'],
  [/\bOpenAI\b/gi, 'openai'],
  [/\bAnthropic\b/gi, 'anthropic'],
  [/\bCloudflare\b/gi, 'cloudflare'],
  [/\bTwitch\b/gi, 'twitch'],
  [/\bGitHub\b/gi, 'github'],
  [/\bSlack\b/gi, 'slack'],
  [/\bDiscord\b/gi, 'discord'],
  [/\bPostHog\b/gi, 'posthog'],
  [/\bLogtail\b/gi, 'logtail'],
  [/\bPlanetScale\b/gi, 'planetscale'],
  [/\bSupabase\b/gi, 'supabase'],
  [/\bNeon\b(?:db)?\b/gi, 'neondb'],
  [/\bVercel\b/gi, 'vercel'],
  [/\bRailway\b/gi, 'railway'],
  [/\bFly\.io\b/gi, 'fly_io'],
];

// Privacy / policy terms
const POLICY_TERMS: ReadonlyArray<[RegExp, string]> = [
  [/\bGDPR\b/gi, 'gdpr'],
  [/\bCCPA\b/gi, 'ccpa'],
  [/\bHIPAA\b/gi, 'hipaa'],
  [/\bCOPPA\b/gi, 'coppa'],
  [/\bSOC\s*2\b/gi, 'soc2'],
  [/\bPCI[\s-]DSS\b/gi, 'pci_dss'],
  [/\bISO\s*27001\b/gi, 'iso_27001'],
  [/\bcookie\s+(?:policy|consent|banner|law)\b/gi, 'cookie_policy'],
  [/\bprivacy\s+policy\b/gi, 'privacy_policy'],
  [/\bterms\s+of\s+service\b/gi, 'terms_of_service'],
  [/\bdata\s+retention\b/gi, 'data_retention'],
  [/\bright\s+to\s+(?:be\s+)?forgotten\b/gi, 'right_to_erasure'],
  [/\bdata\s+processing\s+agreement\b/gi, 'dpa'],
];

// User roles / access levels
const ROLE_NAMES: ReadonlyArray<[RegExp, string]> = [
  [/\b(admin(?:istrator)?|superuser|root)\b/gi, 'admin_role'],
  [/\b(editor|author|contributor)\b/gi, 'editor_role'],
  [/\b(viewer|reader|observer)\b/gi, 'viewer_role'],
  [/\b(owner|billing[\s_](?:admin|manager))\b/gi, 'owner_role'],
  [/\b(guest|anonymous|unauthenticated)\b/gi, 'guest_role'],
  [/\b(moderator|curator)\b/gi, 'moderator_role'],
  [/\b(free|starter|hobby)\s+(?:plan|tier|account)\b/gi, 'free_tier'],
  [/\b(pro|professional|team)\s+(?:plan|tier|account)\b/gi, 'pro_tier'],
  [/\b(enterprise|business)\s+(?:plan|tier|account)\b/gi, 'enterprise_tier'],
];

// ─── Extractor ─────────────────────────────────────────────────────────────────

export interface ExtractionInput {
  text: string;
  sectionId: Hash;
  fileId: Hash;
  lineStart: number;
}

/**
 * Extract all structural entities from a section of text.
 * Returns deduplicated, normalized entities.
 */
export function extractStructuralEntities(input: ExtractionInput): StructuralEntity[] {
  const { text, sectionId, fileId, lineStart } = input;
  const entities: StructuralEntity[] = [];
  const seen = new Set<string>(); // normalized:kind dedup key

  function add(kind: EntityKind, value: string, normalized: string): void {
    const key = `${kind}:${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    entities.push({
      kind,
      value,
      normalized,
      sectionId,
      fileId,
      lineStart,
      confidence: 1.0,
    });
  }

  // Environment variables — highest priority, most deterministic
  for (const match of text.matchAll(ENV_VAR_RE)) {
    const value = match[1];
    if (value && value.length > 2) {
      add('env_variable', value, value.toLowerCase());
    }
  }

  // Feature flags (ALL_CAPS identifiers not already captured as env vars)
  for (const match of text.matchAll(FEATURE_FLAG_RE)) {
    const value = match[1];
    if (!value) continue;
    // Skip common keywords that happen to be caps (HTTP, URL, etc.)
    const skipList = new Set(['HTTP', 'HTTPS', 'URL', 'JSON', 'XML', 'API', 'SQL', 'CSS', 'HTML', 'DOM', 'NULL', 'TRUE', 'FALSE']);
    if (skipList.has(value)) continue;
    if (value.length > 3) {
      add('feature_flag', value, value.toLowerCase());
    }
  }

  // Numeric thresholds
  for (const match of text.matchAll(NUMERIC_THRESHOLD_RE)) {
    const raw = match[0];
    const numStr = match[1] ?? match[2];
    if (numStr) {
      add('numeric_threshold', raw.trim(), raw.trim().toLowerCase().replace(/\s+/g, '_'));
    }
  }

  // API routes
  for (const match of text.matchAll(ROUTE_RE)) {
    const route = match[1];
    if (route) {
      add('url_endpoint', route, route.toLowerCase());
    }
  }

  // URLs
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0];
    if (url && url.length > 15) { // skip trivially short URLs
      add('url_endpoint', url, url.toLowerCase());
    }
  }

  // SDK names
  for (const [pattern, normalized] of SDK_NAMES) {
    if (pattern.test(text)) {
      const found = text.match(pattern)?.[0] ?? normalized;
      add('sdk_reference', found, normalized);
    }
    pattern.lastIndex = 0; // reset stateful regex
  }

  // Policy terms
  for (const [pattern, normalized] of POLICY_TERMS) {
    if (pattern.test(text)) {
      const found = text.match(pattern)?.[0] ?? normalized;
      add('policy_term', found, normalized);
    }
    pattern.lastIndex = 0;
  }

  // Role/tier names
  for (const [pattern, normalized] of ROLE_NAMES) {
    if (pattern.test(text)) {
      const found = text.match(pattern)?.[0] ?? normalized;
      add('role_name', found, normalized);
    }
    pattern.lastIndex = 0;
  }

  return entities;
}

/**
 * Given two sets of structural entities (from different sections),
 * find overlapping entities that form a direct dependency link.
 *
 * Returns pairs where the same entity appears in both sections.
 * These are guaranteed STRUCTURAL dependency evidence (weight=1.0).
 */
export function findStructuralOverlap(
  entitiesA: StructuralEntity[],
  entitiesB: StructuralEntity[],
): Array<{ entity: StructuralEntity; matchedIn: StructuralEntity }> {
  const mapB = new Map<string, StructuralEntity>();
  for (const e of entitiesB) {
    mapB.set(`${e.kind}:${e.normalized}`, e);
  }

  const result: Array<{ entity: StructuralEntity; matchedIn: StructuralEntity }> = [];
  for (const e of entitiesA) {
    const match = mapB.get(`${e.kind}:${e.normalized}`);
    if (match) {
      result.push({ entity: e, matchedIn: match });
    }
  }
  return result;
}
