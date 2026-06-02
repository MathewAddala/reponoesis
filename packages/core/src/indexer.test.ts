import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Indexer } from './indexer.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { simpleGit } from 'simple-git';

describe('Indexer - Code Constant Mutation Detection', () => {
  const testDir = resolve(process.cwd(), 'temp-test-project');

  beforeAll(async () => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, '.engine'), { recursive: true });

    const git = simpleGit(testDir);
    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');

    writeFileSync(join(testDir, '.engine', 'config.json'), JSON.stringify({
      projectRoot: testDir,
      dbPath: join(testDir, '.engine', 'graph.db'),
      ignorePaths: [],
      enabledParsers: ['text'],
      ai: { primaryModel: 'none', localModel: 'none' },
      gatekeeper: { maxDepth: 8 }
    }));

    writeFileSync(join(testDir, 'terms.txt'), 'The service is provided at no cost.');
    await git.add('terms.txt');
    await git.commit('initial commit');
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should detect undocumented constant mutation in modified file', async () => {
    const config = {
      projectRoot: testDir as any,
      dbPath: join(testDir, '.engine', 'graph.db') as any,
      ignorePaths: [],
      enabledParsers: ['text'] as any,
      ai: { primaryModel: 'none', localModel: 'none' } as any,
      gatekeeper: { maxDepth: 8 } as any
    };

    const indexer = new Indexer(config);
    await indexer.fullScan();

    writeFileSync(join(testDir, 'terms.txt'), 'We charge a flat fee of $10 for advanced features.');

    const git = simpleGit(testDir);
    await git.add('terms.txt');

    const suggestions = await indexer.getSuggestionsForFiles([join(testDir, 'terms.txt') as any]);
    indexer.close();

    expect(suggestions.length).toBe(1);
    expect(suggestions[0].type).toBe('UNDOCUMENTED_CONSTANT_MUTATION');
    expect(suggestions[0].concept).toBe('billing');
    expect(suggestions[0].suggestedCommand).toContain('rpn decide billing');
    expect(suggestions[0].bindCommand).toContain('rpn bind billing');
  });
});
