import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { sha256 } from './crypto';

export interface StoredFile {
  key: string;
  sha256: string;
  size: number;
}

export interface StorageAdapter {
  put(data: Buffer): Promise<StoredFile>;
  stream(key: string): Readable;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

const KEY_RE = /^[a-f0-9]{64}$/;

/**
 * Content-addressed local file storage. Keys are SHA-256 hex digests, so user input never
 * reaches the file system path (no traversal possible).
 */
export class LocalStorage implements StorageAdapter {
  constructor(private dir: string) {}

  private path(key: string): string {
    if (!KEY_RE.test(key)) throw new Error('Invalid storage key');
    return join(this.dir, key.slice(0, 2), key.slice(2, 4), key);
  }

  async put(data: Buffer): Promise<StoredFile> {
    const key = sha256(data);
    const path = this.path(key);
    await mkdir(join(this.dir, key.slice(0, 2), key.slice(2, 4)), { recursive: true });
    await writeFile(path, data);
    return { key, sha256: key, size: data.length };
  }

  stream(key: string): Readable {
    return createReadStream(this.path(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.path(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}
