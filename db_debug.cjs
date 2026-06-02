const Database = require('better-sqlite3');
const path = require('path');

const dbPath = 'C:\\Users\\addal\\OneDrive\\Desktop\\testproject\\.engine\\graph.db';
const db = new Database(dbPath);

console.log('=== DECISIONS ===');
console.log(db.prepare('SELECT id, label, title FROM decisions').all());

console.log('=== DECISION LINKS ===');
console.log(db.prepare('SELECT * FROM decision_links').all());

console.log('=== SECTIONS ===');
console.log(db.prepare('SELECT id, file_id, line_start, line_end FROM sections').all());

console.log('=== FILES ===');
console.log(db.prepare('SELECT id, path FROM files').all());

db.close();
