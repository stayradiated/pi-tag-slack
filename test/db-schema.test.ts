import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../src/db.js';

const dirs: string[] = [];
function path(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-tag-slack-schema-'));
  dirs.push(dir);
  return join(dir, 'gateway.db');
}
afterEach(() => {
  closeDb();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('schema version 1 baseline', () => {
  it('creates the complete version-1 schema and reopens it', () => {
    const dbPath = path();
    initDb(dbPath);
    closeDb();
    const sqlite = new Database(dbPath, { readonly: true });
    try {
      expect(sqlite.pragma('user_version', { simple: true })).toBe(1);
      for (const table of [
        'channels',
        'message_queue',
        'message_log',
        'scheduled_tasks',
        'trusted_users',
      ]) {
        expect(
          sqlite
            .prepare("select name from sqlite_master where type = 'table' and name = ?")
            .get(table),
        ).toBeTruthy();
      }
      expect(
        sqlite
          .prepare(
            "select name from sqlite_master where type = 'index' and name = 'idx_queue_status'",
          )
          .get(),
      ).toBeTruthy();
      expect(
        sqlite
          .prepare(
            "select name from sqlite_master where type = 'index' and name = 'idx_scheduled_tasks_due'",
          )
          .get(),
      ).toBeTruthy();
    } finally {
      sqlite.close();
    }
    expect(() => initDb(dbPath)).not.toThrow();
  });

  it('rejects pre-release and newer schemas without poisoning later initialization', () => {
    const dbPath = path();
    const sqlite = new Database(dbPath);
    sqlite.exec('create table channels (jid text);');
    sqlite.close();
    expect(() => initDb(dbPath)).toThrow(/Pre-release/);
    rmSync(dbPath);
    expect(() => initDb(dbPath)).not.toThrow();
    closeDb();

    const newer = new Database(dbPath);
    newer.pragma('user_version = 2');
    newer.close();
    expect(() => initDb(dbPath)).toThrow(/Unsupported/);
  });

  it('does not silently reuse a different open database', () => {
    const first = path();
    const second = path();
    initDb(first);
    expect(() => initDb(second)).toThrow(/already open/);
  });
});
