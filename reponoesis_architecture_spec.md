# REPONOESIS: Cryptographic Semantic Drift Gating & Memory Graph
### Technical Whitepaper and Architectural Specification
*Prepared by: Student Developer & Researcher, KL University, India*

---

## Executive Summary

Modern AI software agents represent a massive leap forward, but they are limited by two systemic issues:
1. Agent Amnesia: AI agents lack a shared, persistent semantic memory of architectural design agreements between disjointed chat sessions.
2. Silent Semantic Drift: Code updates (e.g., changes to rate limits, pricing tiers, or database constants) break high-level design constraints without triggering compiler or linter errors.

Reponoesis introduces an offline Merkle Semantic Graph Database running locally via a Model Context Protocol (MCP) server. It locks code blocks to decisions using SHA-3 hashes. When code is modified, the agent uses its reasoning capabilities to write descriptive drift explanations back to the database, converting raw cryptographic warnings into clear business logic impacts. 

---

## Visual Project Flow & Lifecycle

```text
==========================================================================================
                     REPONOESIS LIFECYCLE & SEMANTIC DATA PIPELINE
==========================================================================================

 [1. SESSION START]  ◄─── Agent calls: rpn_get_context()
        │
        ▼
 ┌──────────────┐        Prime agent working memory with the
 │ IDE AI Agent │ ◄───── active Architectural Decisions (ADR)
 └──────┬───────┘        and structural concept maps.
        │
 [2. BEFORE EDIT]    ◄─── Agent calls: rpn_impact_map(files)
        │
        ▼
 ┌──────────────┐        Traces dependencies to determine the
 │ Blast Radius │ ◄───── blast radius before any files are modified.
 └──────┬───────┘        Preventing accidental upstream changes.
        │
 [3. CODE MUTATE]    ◄─── Developer/Agent writes updates to files
        │
        ▼
 ┌──────────────┐        Calculates normalized SHA-3 AST hashes.
 │ Cryptographic│ ◄───── Detects mismatch against database baseline.
 │ Hash Checker │        State changes to [CHAIN_BROKEN].
 └──────┬───────┘
        │
 [4. WRITE-BACK]     ◄─── Agent calls: rpn_record_drift_explanation()
        │
        ▼
 ┌──────────────┐        Agent analyzes code delta and writes custom
 │ Agent Brain  ├─────►  logic explanations back to database.
 └──────────────┘        (e.g., "Subscription Price reduced to $29")
                        
 [5. GATE & VIEW]    ◄─── Web HUD Visualizer renders broken traces.
                         `rpn check` Git hook gates commit if broken.
==========================================================================================
```

---

## Relational Database Schema Specifications

Reponoesis stores its knowledge graph locally using a high-performance SQLite database with Write-Ahead Logging (WAL). This ensures that intellectual property and source code never leave the local filesystem.

| Table Name | Primary Key | Foreign Keys | System Purpose |
| :--- | :--- | :--- | :--- |
| files | id (Path Hash) | None | Tracks indexed filesystem absolute paths and status. |
| sections | id (Block Hash) | file_id -> files.id | Indexes AST syntax coordinates and normalized contents. |
| decisions | id (Label Hash) | None | Stores Architectural Decisions (ADR) markdown documents. |
| decision_links | (decision_id, section_id) | decision_id, section_id | Bridges specific code blocks to ADR rationale. |
| concepts | id (Concept Hash) | section_id, file_id | Tracks semantic concept assignments and active drift. |
| semantic_violations | id (Conflict Hash) | None | Stores active contradictions between two file nodes. |

### Database Schema (DDL)
```sql
CREATE TABLE files (
    id TEXT PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    kind TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    section_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE sections (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    line_start INTEGER NOT NULL,
    line_end INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    raw_text TEXT NOT NULL,
    kind TEXT NOT NULL,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE decisions (
    id TEXT PRIMARY KEY,
    label TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE decision_links (
    decision_id TEXT NOT NULL,
    section_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    chain_link TEXT NOT NULL,
    chain_state TEXT NOT NULL,
    drift_explanation TEXT,
    PRIMARY KEY (decision_id, section_id),
    FOREIGN KEY (decision_id) REFERENCES decisions(id) ON DELETE CASCADE,
    FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE concepts (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    canonical TEXT NOT NULL,
    section_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    confidence TEXT NOT NULL,
    chain_link TEXT NOT NULL,
    chain_state TEXT NOT NULL,
    drift_explanation TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE semantic_violations (
    id TEXT PRIMARY KEY,
    concept_label TEXT NOT NULL,
    file_a_path TEXT NOT NULL,
    line_start_a INTEGER NOT NULL,
    file_b_path TEXT NOT NULL,
    line_start_b INTEGER NOT NULL,
    reason TEXT NOT NULL,
    proposed_fix TEXT NOT NULL,
    severity TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
```

---

## CLI Interface Commands

The command-line suite governs configuration, scanning, and pipeline gating.

### 1. Workspace Lifecycle
*   `rpn init`: Initializes `.engine/` folders and SQL schemas.
*   `rpn scan`: Walks directories, extracts AST coordinates, hashes contents, and constructs the local graph.
*   `rpn status`: Displays the high-level Chain Health Dashboard.
*   `rpn status --broken`: Outputs verbose details of all broken links and active logical violations.

### 2. Guardrails & Validation
*   `rpn check`: Scans git staged files relative to the git root. Blocks commits if critical contradictions are active.
*   `rpn decide <label>`: Authorizes a new architectural contract (creates markdown files under `.rpn/decisions/`).
*   `rpn bind <label> <file>`: Binds an architectural decision directly to code block ranges.

### 3. Handover Packets
*   `rpn pack`: Serializes database states, active links, and developer briefings into a token-optimized `rpn_handover.json` file.
*   `rpn unpack <file>`: Re-hydrates local database states from a handover file, instantly resolving agent amnesia.

---

## Model Context Protocol (MCP) Tool Specifications

AI agents make stdio requests using JSON-RPC 2.0. Below are the key tools and payload examples.

### 1. Tool Summary Table

| Tool Name | Arguments | Behavior |
| :--- | :--- | :--- |
| `rpn_get_context` | None | Returns active ADRs, concept maps, and audit logs. |
| `rpn_impact_map` | `files: string[]` | Scans dependencies and returns semantic blast radius. |
| `rpn_validate` | `changed_files: string[]` | Checks Merkle signatures and details broken links. |
| `rpn_record_concept`| `file, label, description` | Anchors a semantic understanding to an AST section. |
| `rpn_record_decision`| `label, title, body, files`| Records a new ADR and auto-binds to targeted paths. |
| `rpn_record_drift_explanation` | `concept_id, explanation` | Injects agent's plain-English explanation into the DB. |

### 2. Request/Response Payload Example (`rpn_record_drift_explanation`)
*   **Request RPC**:
    ```json
    {
      "jsonrpc": "2.0",
      "method": "tools/call",
      "params": {
        "name": "rpn_record_drift_explanation",
        "arguments": {
          "concept_id": "768dfbe16247fdee534179145b9ad2d0c1ddeaff8a4fe310b8103450af0dc96e",
          "explanation": "Agent-Injected Drift Explanation: The Pro plan price was lowered to $29 per month in billing.ts. Stripe configuration must be updated."
        }
      },
      "id": 12
    }
    ```
*   **Response RPC**:
    ```json
    {
      "jsonrpc": "2.0",
      "result": {
        "content": [{
          "type": "text",
          "text": "{\n  \"status\": \"RECORDED\",\n  \"concept_id\": \"768dfbe16247fdee534179145b9ad2d0c1ddeaff8a4fe310b8103450af0dc96e\",\n  \"message\": \"Custom drift explanation recorded successfully.\"\n}"
        }]
      },
      "id": 12
    }
    ```
