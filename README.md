# Semantic Dependency Engine [CODENAME — name TBD]

> **Deterministic semantic dependency tracking for AI-native codebases.**
> When an AI agent changes one file, this engine tells you — with cryptographic certainty — what else needs to change.

---

## The Problem

AI agents are excellent at editing individual files. They fail at cross-file semantic consistency.

**The pattern:**
```
AI turns off ads in analytics.ts
→ Doesn't update privacy-policy.md (still mentions ads)
→ Doesn't update STORE_LISTING.md (still mentions personalized ads)  
→ Doesn't update CookieBanner.tsx (still shows consent for ads that don't run)
```

This is not a bug. It's a structural gap — no tool tracks *semantic* dependencies across file types.

## What We Built

A **Concept Merkle Chain** — a cryptographic graph of semantic dependencies across your entire project.

Every concept (`ad_tracking`, `free_plan_limit`, `gdpr_consent`) gets fingerprinted with SHA3-256.
When a file changes, the chain link invalidates **deterministically** — no threshold, no fuzzy "maybe".

### How it works

```
File A changes → sectionHash(A) changes
                → ChainLink(A) = SHA3-256(conceptId | parentLink | sectionHash) changes
                → All downstream ChainLinks that depend on A are now BROKEN
                → Engine reports: CHAIN_BROKEN at privacy-policy.md:L142-L189
```

This is deterministic. Either the hash matches or it doesn't.

## Architecture

```
packages/
  core/    — AST parser, structural entity extractor, SQLite graph, Merkle chain
  cli/     — engine init | scan | check | review | status | query
  mcp/     — MCP server for Cursor/Claude Code/Gemini (4 tools)
  ui/      — Circuit board visualization (coming Week 9)
```

## Usage

```bash
# Initialize in your project
npx engine init --gemini-key YOUR_KEY

# Full index
engine scan

# Check before commit (also runs automatically via pre-commit hook)
engine check

# Interactive review of broken chains
engine review

# Find where a concept lives
engine query "ad_tracking"

# Show health dashboard
engine status
```

## MCP Integration (AI Agents)

Add to your Cursor/Claude Code config:
```json
{
  "engine": {
    "command": "engine-mcp",
    "args": ["--project", "/path/to/your/project"]
  }
}
```

AI agents get 4 tools:
- `engine_impact_map` — call BEFORE changes
- `engine_validate` — call AFTER changes  
- `engine_query` — find concept locations
- `engine_acknowledge` — mark intentional drift

## Packages

| Package | Description |
|---|---|
| `@engine/core` | AST parsing, SHA3 fingerprinting, SQLite graph, chain validation |
| `@engine/cli` | CLI tool (`engine` command) |
| `@engine/mcp` | MCP server for AI agent integration |

---

*Name TBD — will rename @engine/* to final product name before launch.*
