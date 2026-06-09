const { Indexer } = require('./packages/core/dist/index.js');
const path = require('path');

const config = {
  projectRoot: path.resolve(__dirname, 'sample-app'),
  dbPath: path.resolve(__dirname, 'sample-app/.engine/graph.db'),
};

const indexer = new Indexer(config);

const broken = indexer.getAllBrokenChains();
console.log('Broken chains before:', broken.length);

for (const b of broken) {
  console.log(`Resolving: ${b.conceptLabel} on ${b.filePath}`);
  indexer.resolveBrokenChain(b.conceptId);
}

indexer.close();
console.log('Drift resolved in database!');
