import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Retain existing storage interfaces; all data lives in one local SQLite file.
class SqliteStatement {
  constructor(statement, parameters = []) {
    this.statement = statement;
    this.parameters = parameters;
  }

  bind(...parameters) {
    return new SqliteStatement(this.statement, parameters);
  }

  async first(column) {
    const row = this.statement.get(...this.parameters);
    return column === undefined ? row || null : (row?.[column] ?? null);
  }

  async all() {
    return { success: true, results: this.statement.all(...this.parameters) };
  }

  async run() {
    const result = this.statement.run(...this.parameters);
    return {
      success: true,
      meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
    };
  }
}

export function openSqliteStorage(filename) {
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(filename);
  try {
    database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    database.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    database.exec(`
      CREATE TABLE IF NOT EXISTS kv_entries (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_kv_expiration ON kv_entries(expires_at);
    `);
  } catch (error) {
    database.close();
    throw error;
  }

  const read = database.prepare(`
    SELECT value FROM kv_entries WHERE key = ?
      AND (expires_at IS NULL OR expires_at > ?)
  `);
  const write = database.prepare(`
    INSERT INTO kv_entries (key, value, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
  `);
  const remove = database.prepare('DELETE FROM kv_entries WHERE key = ?');
  const list = database.prepare(`
    SELECT key, expires_at FROM kv_entries
    WHERE (expires_at IS NULL OR expires_at > ?) AND (? = '' OR instr(key, ?) = 1)
    ORDER BY key
  `);
  const purge = database.prepare('DELETE FROM kv_entries WHERE expires_at <= ?');
  const now = () => Math.floor(Date.now() / 1000);
  const purgeExpired = () => purge.run(now());
  purgeExpired();

  return {
    kv: {
      async get(key, options = 'text') {
        const row = read.get(String(key), now());
        if (!row) return null;
        const type = typeof options === 'string' ? options : options.type;
        return type === 'json' ? JSON.parse(row.value) : row.value;
      },

      async put(key, value, options = {}) {
        if (typeof value !== 'string') throw new TypeError('KV values must be strings');
        let expiration = null;
        if (options.expirationTtl !== undefined) {
          expiration = now() + Number(options.expirationTtl);
        } else if (options.expiration !== undefined) {
          expiration = Number(options.expiration);
        }
        if (expiration !== null && (!Number.isFinite(expiration) || expiration < 0)) {
          throw new TypeError('Invalid KV expiration');
        }
        write.run(String(key), value, expiration);
      },

      async delete(key) {
        remove.run(String(key));
      },

      async list({ prefix = '' } = {}) {
        return {
          keys: list.all(now(), prefix, prefix).map((row) => ({
            name: row.key,
            ...(row.expires_at === null ? {} : { expiration: row.expires_at }),
          })),
          list_complete: true,
        };
      },
    },
    db: {
      prepare(sql) {
        return new SqliteStatement(database.prepare(sql));
      },
    },
    purgeExpired,
    close() {
      database.close();
    },
  };
}
