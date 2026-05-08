import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DDL_BASE } from './schema'
import {
  migrateToV2IfNeeded,
  migrateToV3IfNeeded,
  migrateToV4IfNeeded,
  migrateToV5IfNeeded,
  migrateToV6IfNeeded,
  migrateToV7IfNeeded,
  migrateToV8IfNeeded,
  migrateToV9IfNeeded,
  migrateToV10IfNeeded,
  migrateToV11IfNeeded,
  migrateToV12IfNeeded,
  migrateToV13IfNeeded,
  migrateToV14IfNeeded,
  migrateToV15IfNeeded,
  migrateToV16IfNeeded
} from './migrate'

let db: Database.Database | null = null

/** Целевая версия миграций (см. migrate.ts). */
export const SCHEMA_VERSION = 16

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('База данных не инициализирована')
  }
  return db
}

function hasMigration(instance: Database.Database, version: number): boolean {
  const row = instance.prepare('SELECT 1 AS x FROM schema_migrations WHERE version = ?').get(version) as
    | { x: number }
    | undefined
  return Boolean(row)
}

export function initDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true })
  const instance = new Database(dbPath)
  instance.pragma('journal_mode = WAL')
  instance.pragma('foreign_keys = ON')
  instance.exec(DDL_BASE)
  migrateToV2IfNeeded(instance)
  migrateToV3IfNeeded(instance)
  migrateToV4IfNeeded(instance)
  migrateToV5IfNeeded(instance)
  migrateToV6IfNeeded(instance)
  migrateToV7IfNeeded(instance)
  migrateToV8IfNeeded(instance)
  migrateToV9IfNeeded(instance)
  migrateToV10IfNeeded(instance)
  migrateToV11IfNeeded(instance)
  migrateToV12IfNeeded(instance)
  migrateToV13IfNeeded(instance)
  migrateToV14IfNeeded(instance)
  migrateToV15IfNeeded(instance)
  migrateToV16IfNeeded(instance)
  if (!hasMigration(instance, SCHEMA_VERSION)) {
    instance.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(SCHEMA_VERSION)
  }

  db = instance
  return instance
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
