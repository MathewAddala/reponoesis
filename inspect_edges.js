const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.resolve(__dirname, 'sample-app/.engine/graph.db'));

console.log('\n=== EDGES ===');
const edges = db.prepare('SELECT * FROM edges').all();
console.log('Count:', edges.length);
edges.forEach(e => {
  console.log(e.id, '|', e.from_id.slice(0, 10), '->', e.to_id.slice(0, 10), '|', e.edge_type);
});

db.close();
