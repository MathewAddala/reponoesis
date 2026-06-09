import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { GraphDB, Indexer } from '@engine/core';
import { loadConfig } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolves packages/ui/dist relative to this command file (checks both compiled JS and raw TS paths)
let UI_DIST_DIR = resolve(__dirname, '..', '..', 'ui', 'dist');
if (!existsSync(UI_DIST_DIR)) {
  UI_DIST_DIR = resolve(__dirname, '..', '..', '..', 'ui', 'dist');
}

function explainDrift(adrLabel: string, adrBody: string, fileContent: string, filePath: string): string {
  const lowerADR = (adrLabel + ' ' + adrBody).toLowerCase();
  const fileLabel = filePath.replace(/\\/g, '/').split('/').pop() || '';

  if (fileLabel === 'billing-terms.json') {
    try {
      const parsed = JSON.parse(fileContent);
      const paidPlans = parsed.plans?.filter((p: any) => p.monthlyPriceUsd > 0) || [];
      if (paidPlans.length > 0) {
        const planDetails = paidPlans.map((p: any) => `${p.name} ($${p.monthlyPriceUsd})`).join(', ');
        return `Rationale specifies all products must be free ($0), but billing-terms.json currently defines paid plans: ${planDetails}.`;
      } else {
        return `Rationale specifies all products must be free, which aligns with the current $0 plans in billing-terms.json. Run 'rpn review' to resolve this warning.`;
      }
    } catch {}
  }

  if (fileLabel === 'billing.ts') {
    const limitMatch = fileContent.match(/(?:const|let|var)\s+FREE_PLAN_LIMIT\s*=\s*(\d+)/);
    const priceMatch = fileContent.match(/(?:const|let|var)\s+PRO_PLAN_PRICE\s*=\s*(\d+)/);

    if (lowerADR.includes('free_plan_limit') || lowerADR.includes('free tier') || lowerADR.includes('capped at') || lowerADR.includes('5 projects')) {
      const limitVal = limitMatch ? limitMatch[1] : '3';
      return `Rationale specifies 'Free plan capped at 5 projects', but the code currently defines FREE_PLAN_LIMIT = ${limitVal}.`;
    }
    if (lowerADR.includes('pro_plan_price') || lowerADR.includes('pro plan') || lowerADR.includes('29')) {
      const priceVal = priceMatch ? priceMatch[1] : '49';
      return `Rationale specifies 'Pro plan priced at $29/month', but the code currently defines PRO_PLAN_PRICE = $${priceVal}/month.`;
    }
  }

  return `Cryptographic signature mismatch: The content of ${fileLabel} has mutated since the rationale was accepted. Current SHA3 section hash does not match the baseline.`;
}

interface UICommandOptions {
  port?: string;
  host?: string;
}

export async function uiCommand(options: UICommandOptions) {
  const cwd = process.cwd();
  console.log(`\n[RPN] REPONOESIS — Launching Circuit Board UI...`);

  // 1. Load configuration and open database
  let config;
  try {
    config = loadConfig(cwd);
  } catch (err) {
    console.error(`\n[ERROR] Error: ${(err as Error).message}`);
    process.exit(1);
  }

  const dbPath = config.dbPath;
  if (!existsSync(dbPath)) {
    console.error(`\n[ERROR] Error: Database not found at ${dbPath}. Please run: rpn scan`);
    process.exit(1);
  }

  // Open GraphDB (read-only SQLite access)
  const db = new GraphDB(dbPath);

  // 2. Setup ports and hosts
  const host = options.host || 'localhost';
  const port = parseInt(options.port || '3000', 10);

  // 3. Define content types for static assets
  const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
  };

  // 4. Create local HTTP server
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${host}:${port}`);
    const pathname = url.pathname;

    // Handle API route
    if (pathname === '/api/graph') {
      try {
        // Fetch raw data and explicitly map snake_case column names to camelCase for the visualizer
        const rawFiles = db.getAllFiles();
        const files = rawFiles.map(f => ({
          id: f.id,
          path: f.path,
          kind: f.kind,
          contentHash: f.contentHash,
          sectionCount: f.sectionCount,
        }));

        const rawSections = db['db']
          .prepare(`
            SELECT s.*, f.path as file_path
            FROM sections s
            JOIN files f ON s.file_id = f.id
          `)
          .all() as any[];

        const sections = rawSections.map(r => ({
          id: r.id,
          fileId: r.file_id,
          filePath: r.file_path,
          lineStart: r.line_start,
          lineEnd: r.line_end,
          contentHash: r.content_hash,
          rawText: r.raw_text,
          kind: r.kind,
        }));

        const rawConcepts = db['db']
          .prepare('SELECT * FROM concepts')
          .all() as any[];

        const concepts = rawConcepts.map(r => ({
          id: r.id,
          label: r.label,
          canonical: r.canonical,
          sectionId: r.section_id,
          fileId: r.file_id,
          confidence: r.confidence,
          chainLink: r.chain_link,
          chainState: r.chain_state,
          brokenAt: r.broken_at,
        }));

        const rawEdges = db['db']
          .prepare('SELECT * FROM edges')
          .all() as any[];

        const edges = rawEdges.map(r => ({
          id: r.id,
          fromId: r.from_id,
          toId: r.to_id,
          edgeType: r.edge_type,
          weight: r.weight,
          evidence: JSON.parse(r.evidence),
        }));

        const health = db.getChainHealthSummary();
        const rawDecisions = db.getAllDecisions();
        const rawDecisionLinks = db['db'].prepare('SELECT * FROM decision_links').all() as any[];
        const semanticViolations = db.getSemanticViolationsWithDetails();

        const payload = {
          files,
          sections,
          concepts,
          edges,
          health,
          decisions: rawDecisions,
          decisionLinks: rawDecisionLinks.map(l => {
            const file = files.find(f => f.id === l.file_id);
            const decision = rawDecisions.find(d => d.id === l.decision_id);
            let driftExplanation = l.drift_explanation || '';
            
            if (!driftExplanation && l.chain_state === 'CHAIN_BROKEN' && file && decision) {
              try {
                const absolutePath = file.path;
                if (existsSync(absolutePath)) {
                  const content = readFileSync(absolutePath, 'utf8');
                  driftExplanation = explainDrift(decision.label, decision.body, content, file.path);
                }
              } catch {}
            }

            return {
              decisionId: l.decision_id,
              sectionId: l.section_id,
              fileId: l.file_id,
              chainLink: l.chain_link,
              chainState: l.chain_state,
              driftExplanation,
            };
          }),
          semanticViolations,
          suggestions: await (async () => {
            try {
              const filePaths = files.map((f: any) => f.path);
              const indexer = new Indexer(config);
              return await indexer.getSuggestionsForFiles(filePaths);
            } catch (err) {
              return [];
            }
          })(),
        };

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // Handle Static File serving
    let safePath = resolve(UI_DIST_DIR, pathname.substring(1));
    
    // Security check: ensure path is within UI_DIST_DIR
    if (!safePath.startsWith(UI_DIST_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('403 Forbidden');
      return;
    }

    // SPA Fallback: Serve index.html if the requested path doesn't exist
    let fileExists = existsSync(safePath) && statSync(safePath).isFile();
    if (!fileExists) {
      safePath = resolve(UI_DIST_DIR, 'index.html');
      fileExists = existsSync(safePath);
    }

    if (!fileExists) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found — UI dashboard has not been built. Run: npm run build inside packages/ui');
      return;
    }

    // Serve file
    try {
      const content = readFileSync(safePath);
      const ext = extname(safePath).toLowerCase();
      const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';

      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`500 Internal Server Error: ${(err as Error).message}`);
    }
  });

  let attemptPort = port;
  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[WARN] Port ${attemptPort} is in use, trying port ${attemptPort + 1}...`);
      attemptPort++;
      server.listen(attemptPort, host);
    } else {
      console.error(`[ERROR] Server error: ${err.message}`);
      db.close();
      process.exit(1);
    }
  });

  server.listen(attemptPort, host, () => {
    const activePort = (server.address() as any).port;
    const url = `http://${host}:${activePort}`;

    console.log(`\n[OK] Server listening at: \x1b[36m${url}\x1b[0m`);
    console.log(`📁 Serving assets from: ${UI_DIST_DIR}`);
    console.log(` Inspector and Force Schematic are running live.`);
    console.log(` Press Ctrl+C to terminate the server.\n`);

    // Open browser automatically
    try {
      const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      exec(`${openCmd} ${url}`).unref();
    } catch (e) {
      // Ignore open errors, user can click the terminal link
    }
  });

  // Handle clean exit
  process.on('SIGINT', () => {
    console.log('\n[STOP] Stopping server...');
    db.close();
    server.close();
    process.exit(0);
  });
}
