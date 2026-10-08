import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function getCachePath(cacheDir: string, key: string): string {
  return join(cacheDir, `${createHash('sha1').update(key).digest('hex')}.json`);
}

export function readJsonCache<T>(cacheDir: string, key: string): T | null {
  try {
    return JSON.parse(readFileSync(getCachePath(cacheDir, key), 'utf8'));
  } catch {
    return null;
  }
}

export function writeJsonCache(cacheDir: string, key: string, data: unknown): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(getCachePath(cacheDir, key), JSON.stringify(data, null, 2) + '\n');
}
