/**
 * Config loader — reads .engine/config.json and validates it
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EngineConfig } from '@engine/core';

export function loadConfig(cwd: string): EngineConfig {
  const configPath = resolve(cwd, '.engine', 'config.json');

  if (!existsSync(configPath)) {
    throw new Error(`Config not found at ${configPath}. Run: rpn init`);
  }

  try {
    const raw = readFileSync(configPath, 'utf8');
    return JSON.parse(raw) as EngineConfig;
  } catch (err) {
    throw new Error(`Failed to parse config: ${err instanceof Error ? err.message : String(err)}`);
  }
}
