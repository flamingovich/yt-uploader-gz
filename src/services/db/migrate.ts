import type Database from 'better-sqlite3'

type TableInfo = { name: string; notnull: number }

function pragmaTableInfo(db: Database.Database, table: string): TableInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as TableInfo[]
}

/**
 * Миграция на схему v2: SOCKS5-поле scheme у прокси; канал может быть без прокси (proxy_id NULL).
 */
export function migrateToV2IfNeeded(db: Database.Database): void {
  const proxyCols = pragmaTableInfo(db, 'proxies')
  if (!proxyCols.some((c) => c.name === 'scheme')) {
    db.exec(`ALTER TABLE proxies ADD COLUMN scheme TEXT NOT NULL DEFAULT 'socks5'`)
  }

  const chCols = pragmaTableInfo(db, 'channels')
  const proxyCol = chCols.find((c) => c.name === 'proxy_id')
  if (!proxyCol || proxyCol.notnull !== 1) {
    return
  }

  db.pragma('foreign_keys = OFF')
  db.exec('BEGIN')
  try {
    db.exec(`
CREATE TABLE channels_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proxy_id INTEGER REFERENCES proxies (id) ON DELETE SET NULL,
  youtube_channel_id TEXT UNIQUE,
  channel_title TEXT,
  oauth_refresh_token TEXT,
  oauth_access_token TEXT,
  token_expires_at TEXT,
  source_folder_path TEXT,
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO channels_new (
  id, proxy_id, youtube_channel_id, channel_title, oauth_refresh_token,
  oauth_access_token, token_expires_at, source_folder_path, is_enabled, created_at, updated_at
)
SELECT
  id, proxy_id, youtube_channel_id, channel_title, oauth_refresh_token,
  oauth_access_token, token_expires_at, source_folder_path, is_enabled, created_at, updated_at
FROM channels;
DROP TABLE channels;
ALTER TABLE channels_new RENAME TO channels;
`)
    db.exec(`
CREATE INDEX IF NOT EXISTS idx_channels_proxy ON channels (proxy_id);
CREATE INDEX IF NOT EXISTS idx_channels_enabled ON channels (is_enabled);
`)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  } finally {
    db.pragma('foreign_keys = ON')
  }
}

/**
 * Миграция v3: отдельные OAuth-профили (Cloud-проект / Desktop client) и привязка канала.
 */
export function migrateToV3IfNeeded(db: Database.Database): void {
  const master = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'oauth_profiles'`)
    .get() as { name: string } | undefined
  if (!master) {
    db.exec(`
CREATE TABLE oauth_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  google_client_id TEXT NOT NULL,
  google_client_secret TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_oauth_profiles_label ON oauth_profiles (label);
`)
  }

  const chCols = pragmaTableInfo(db, 'channels')
  if (!chCols.some((c) => c.name === 'oauth_profile_id')) {
    db.exec(
      `ALTER TABLE channels ADD COLUMN oauth_profile_id INTEGER REFERENCES oauth_profiles (id) ON DELETE SET NULL`
    )
  }
  const chColsFinal = pragmaTableInfo(db, 'channels')
  if (chColsFinal.some((c) => c.name === 'oauth_profile_id')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_channels_oauth_profile ON channels (oauth_profile_id)`)
  }
}

/**
 * Миграция v4: пресеты публикации на уровне канала (описание/категория/язык/график).
 */
export function migrateToV4IfNeeded(db: Database.Database): void {
  const chCols = pragmaTableInfo(db, 'channels')
  const has = (name: string): boolean => chCols.some((c) => c.name === name)
  if (!has('default_description')) {
    db.exec(`ALTER TABLE channels ADD COLUMN default_description TEXT`)
  }
  if (!has('default_category_id')) {
    db.exec(`ALTER TABLE channels ADD COLUMN default_category_id TEXT NOT NULL DEFAULT '22'`)
  }
  if (!has('default_language')) {
    db.exec(`ALTER TABLE channels ADD COLUMN default_language TEXT NOT NULL DEFAULT 'ru'`)
  }
  if (!has('publish_mode')) {
    db.exec(`ALTER TABLE channels ADD COLUMN publish_mode TEXT NOT NULL DEFAULT 'manual'`)
  }
  if (!has('schedule_start_at')) {
    db.exec(`ALTER TABLE channels ADD COLUMN schedule_start_at TEXT`)
  }
  if (!has('schedule_videos_per_day')) {
    db.exec(`ALTER TABLE channels ADD COLUMN schedule_videos_per_day INTEGER NOT NULL DEFAULT 4`)
  }
  if (!has('schedule_window_start_hour')) {
    db.exec(`ALTER TABLE channels ADD COLUMN schedule_window_start_hour INTEGER NOT NULL DEFAULT 9`)
  }
  if (!has('schedule_window_end_hour')) {
    db.exec(`ALTER TABLE channels ADD COLUMN schedule_window_end_hour INTEGER NOT NULL DEFAULT 23`)
  }
  if (!has('schedule_randomize_minutes')) {
    db.exec(`ALTER TABLE channels ADD COLUMN schedule_randomize_minutes INTEGER NOT NULL DEFAULT 45`)
  }
  if (!has('schedule_timezone')) {
    db.exec(`ALTER TABLE channels ADD COLUMN schedule_timezone TEXT NOT NULL DEFAULT 'Europe/Moscow'`)
  }
}

/**
 * Миграция v5: теги и признак "для детей" по умолчанию.
 */
export function migrateToV5IfNeeded(db: Database.Database): void {
  const chCols = pragmaTableInfo(db, 'channels')
  const has = (name: string): boolean => chCols.some((c) => c.name === name)
  if (!has('default_tags')) {
    db.exec(`ALTER TABLE channels ADD COLUMN default_tags TEXT`)
  }
  if (!has('made_for_kids')) {
    db.exec(`ALTER TABLE channels ADD COLUMN made_for_kids INTEGER NOT NULL DEFAULT 0`)
  }
}

/** Миграция v6: стримеры (RTMP-пайплайн, отдельно от каналов). */
export function migrateToV6IfNeeded(db: Database.Database): void {
  const master = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'streamers'`)
    .get() as { name: string } | undefined
  if (master) return
  db.exec(`
CREATE TABLE streamers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  channel_id INTEGER NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  proxy_id INTEGER REFERENCES proxies (id) ON DELETE SET NULL,
  rtmp_ingest_url TEXT NOT NULL DEFAULT '',
  rtmp_stream_key TEXT NOT NULL DEFAULT '',
  overlay_path TEXT,
  segments_folder_path TEXT,
  bumper_video_path TEXT,
  ffmpeg_extra_args TEXT,
  youtube_broadcast_id TEXT,
  broadcast_title TEXT,
  broadcast_description TEXT,
  broadcast_tags TEXT,
  broadcast_privacy TEXT NOT NULL DEFAULT 'private',
  broadcast_category_id TEXT NOT NULL DEFAULT '22',
  broadcast_thumb_path TEXT,
  last_viewer_count INTEGER,
  last_viewer_checked_at TEXT,
  process_status TEXT NOT NULL DEFAULT 'stopped' CHECK (
    process_status IN ('stopped', 'starting', 'live', 'error')
  ),
  process_error_message TEXT,
  cycle_state_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_streamers_channel ON streamers (channel_id);
`)
}

/** Миграция v7: длительность заглушки перед циклом (секунды / авто). */
export function migrateToV7IfNeeded(db: Database.Database): void {
  const cols = pragmaTableInfo(db, 'streamers')
  if (!cols.some((c) => c.name === 'bumper_pad_target_sec')) {
    db.exec(`ALTER TABLE streamers ADD COLUMN bumper_pad_target_sec INTEGER`)
  }
}

/** Миграция v8: пауза между загрузками на уровне канала. */
export function migrateToV8IfNeeded(db: Database.Database): void {
  const chCols = pragmaTableInfo(db, 'channels')
  if (!chCols.some((c) => c.name === 'upload_cooldown_seconds')) {
    db.exec(
      `ALTER TABLE channels ADD COLUMN upload_cooldown_seconds INTEGER NOT NULL DEFAULT 20`
    )
  }
}

/** Миграция v9: режим «Майнкрафт прогрев» (отдельные куски / SFX / музыка). */
export function migrateToV9IfNeeded(db: Database.Database): void {
  const cols = pragmaTableInfo(db, 'streamers')
  const add = (name: string, ddl: string): void => {
    if (!cols.some((c) => c.name === name)) {
      db.exec(ddl)
    }
  }
  add('minecraft_prewarm_enabled', `ALTER TABLE streamers ADD COLUMN minecraft_prewarm_enabled INTEGER NOT NULL DEFAULT 0`)
  add('minecraft_prewarm_chunks_folder', `ALTER TABLE streamers ADD COLUMN minecraft_prewarm_chunks_folder TEXT`)
  add('minecraft_prewarm_audio_folder', `ALTER TABLE streamers ADD COLUMN minecraft_prewarm_audio_folder TEXT`)
  add('minecraft_prewarm_music_path', `ALTER TABLE streamers ADD COLUMN minecraft_prewarm_music_path TEXT`)
}

/** Миграция v10: ADS profile id на уровне канала. */
export function migrateToV10IfNeeded(db: Database.Database): void {
  const chCols = pragmaTableInfo(db, 'channels')
  if (!chCols.some((c) => c.name === 'ads_profile_id')) {
    db.exec(`ALTER TABLE channels ADD COLUMN ads_profile_id TEXT`)
  }
}

/** Миграция v11: отображаемое имя ADS-профиля (из Local API). */
export function migrateToV11IfNeeded(db: Database.Database): void {
  const chCols = pragmaTableInfo(db, 'channels')
  if (!chCols.some((c) => c.name === 'ads_profile_name')) {
    db.exec(`ALTER TABLE channels ADD COLUMN ads_profile_name TEXT`)
  }
}

/** Миграция v12: управляемый видео-битрейт и режим CBR/VBR для стримеров. */
export function migrateToV12IfNeeded(db: Database.Database): void {
  const cols = pragmaTableInfo(db, 'streamers')
  if (!cols.some((c) => c.name === 'video_bitrate_kbps')) {
    db.exec(`ALTER TABLE streamers ADD COLUMN video_bitrate_kbps INTEGER NOT NULL DEFAULT 6000`)
  }
  if (!cols.some((c) => c.name === 'video_bitrate_mode')) {
    db.exec(`ALTER TABLE streamers ADD COLUMN video_bitrate_mode TEXT NOT NULL DEFAULT 'cbr'`)
  }
  db.exec(`UPDATE streamers SET video_bitrate_mode = 'cbr' WHERE video_bitrate_mode NOT IN ('cbr', 'vbr') OR video_bitrate_mode IS NULL`)
  db.exec(`UPDATE streamers SET video_bitrate_kbps = 6000 WHERE video_bitrate_kbps IS NULL OR video_bitrate_kbps < 200`)
}

/** Миграция v13: статус OAuth для явной индикации валидности авторизации. */
export function migrateToV13IfNeeded(db: Database.Database): void {
  const chCols = pragmaTableInfo(db, 'channels')
  if (!chCols.some((c) => c.name === 'oauth_status')) {
    db.exec(`ALTER TABLE channels ADD COLUMN oauth_status TEXT NOT NULL DEFAULT 'unknown'`)
  }
  db.exec(`UPDATE channels SET oauth_status = 'unknown' WHERE oauth_status NOT IN ('unknown', 'ok', 'invalid') OR oauth_status IS NULL`)
}

/** Миграция v14: режим плейлиста стримера (random / ordered / single). */
export function migrateToV14IfNeeded(db: Database.Database): void {
  const cols = pragmaTableInfo(db, 'streamers')
  if (!cols.some((c) => c.name === 'stream_mode')) {
    db.exec(`ALTER TABLE streamers ADD COLUMN stream_mode TEXT NOT NULL DEFAULT 'random'`)
  }
  db.exec(`UPDATE streamers SET stream_mode = 'random' WHERE stream_mode NOT IN ('random', 'ordered', 'single') OR stream_mode IS NULL`)
}

/** Миграция v15: явный файл для режима single. */
export function migrateToV15IfNeeded(db: Database.Database): void {
  const cols = pragmaTableInfo(db, 'streamers')
  if (!cols.some((c) => c.name === 'single_segment_path')) {
    db.exec(`ALTER TABLE streamers ADD COLUMN single_segment_path TEXT`)
  }
}

/** Миграция v16: сохраненный пресет предпросмотра стрима на уровне канала. */
export function migrateToV16IfNeeded(db: Database.Database): void {
  const chCols = pragmaTableInfo(db, 'channels')
  if (!chCols.some((c) => c.name === 'stream_preview_layout_json')) {
    db.exec(`ALTER TABLE channels ADD COLUMN stream_preview_layout_json TEXT`)
  }
}
