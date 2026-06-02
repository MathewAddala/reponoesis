import Database from 'C:/Users/addal/OneDrive/Desktop/airevenuemachine/node_modules/better-sqlite3/lib/index.js';
import { resolve } from 'path';

const db = new Database(resolve('sample-app/.engine/graph.db'));

console.log('\n=== FILES ===');
const files = db.prepare('SELECT id, path, content_hash FROM files').all();
files.forEach(f => console.log(f.path.split('/').pop(), '->', f.content_hash.slice(0,12)));

console.log('\n=== DECISION LINKS (chain state) ===');
const links = db.prepare(`
  SELECT dl.chain_state, dl.chain_link, d.label, f.path, s.line_start, s.line_end, s.content_hash as section_hash
  FROM decision_links dl
  JOIN decisions d ON dl.decision_id = d.id
  JOIN sections s ON dl.section_id = s.id
  JOIN files f ON dl.file_id = f.id
  ORDER BY d.label, f.path
`).all();
links.forEach(l => {
  const file = l.path.split('\\').pop().split('/').pop();
  console.log(`[${l.chain_state}] ${l.label} -> ${file} | stored:${l.chain_link.slice(0,10)} | section:${l.section_hash.slice(0,10)}`);
});

console.log('\n=== BROKEN DECISION LINKS ===');
const broken = links.filter(l => l.chain_state === 'CHAIN_BROKEN');
if (broken.length === 0) console.log('(none — chain validation may not have run yet)');
broken.forEach(l => console.log('BROKEN:', l.label, '->', l.path.split('\\').pop()));

console.log('\n=== AUDIT LOG (last 8) ===');
const audit = db.prepare('SELECT event_type, actor, meta, timestamp_ms FROM audit_log ORDER BY timestamp_ms DESC LIMIT 8').all();
audit.forEach(a => console.log(a.event_type, '|', a.actor, '|', a.meta));

db.close();
