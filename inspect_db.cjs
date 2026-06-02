const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.resolve(__dirname, 'sample-app/.engine/graph.db'));

console.log('\n=== FILES ===');
const files = db.prepare('SELECT id, path, content_hash FROM files').all();
files.forEach(f => console.log(f.path.split('\\').pop().split('/').pop(), '->', f.content_hash.slice(0,12)));

console.log('\n=== DECISION LINKS ===');
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
  console.log('[' + l.chain_state + '] ' + l.label + ' -> ' + file + ' | stored:' + l.chain_link.slice(0,10) + ' | section:' + l.section_hash.slice(0,10));
});

console.log('\n=== BROKEN LINKS ===');
const broken = links.filter(l => l.chain_state === 'CHAIN_BROKEN');
if (broken.length === 0) console.log('(none found — investigating why)');
broken.forEach(l => console.log('BROKEN:', l.label, '->', l.path.split('\\').pop()));

console.log('\n=== DECISIONS ===');
const decisions = db.prepare('SELECT label, title, status FROM decisions').all();
decisions.forEach(d => console.log('[' + d.status + ']', d.label, '-', d.title));

console.log('\n=== AUDIT (last 6) ===');
const audit = db.prepare('SELECT event_type, actor, meta FROM audit_log ORDER BY timestamp_ms DESC LIMIT 6').all();
audit.forEach(a => console.log(a.event_type, '|', a.actor, '|', a.meta.slice(0, 80)));

db.close();
