import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const dbPath = resolve(process.cwd(), '..', '..', '.engine', 'graph.db');
console.log(`Connecting to database: ${dbPath}`);

const db = new Database(dbPath);

console.log('Mutating database records to simulate cryptographic Merkle desynchronization...');

const updateStmt = db.prepare(`
  UPDATE concepts 
  SET chain_state = 'CHAIN_BROKEN', 
      broken_at = ?,
      chain_link = 'err_merkle_desync_hash_' || substring(id, 1, 8)
  WHERE label IN ('free_plan_limit', 'data_retention_days', 'rate_limit_free')
`);

const result = updateStmt.run(Date.now());
console.log(`Successfully corrupted ${result.changes} concept chains in the database!`);

const updateLinksStmt = db.prepare(`
  UPDATE decision_links
  SET chain_state = 'CHAIN_BROKEN'
`);
const linksResult = updateLinksStmt.run();
console.log(`Successfully corrupted ${linksResult.changes} decision links!`);

db.close();
console.log('Database corruption complete.');
