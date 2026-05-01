/**
 * Схема БД (план):
 *
 * 1) proxies — только SOCKS5 (поле scheme = socks5). host:port уникален.
 * 2) channels — proxy_id может быть NULL (канал без прокси). OAuth поля позже.
 * 3) upload_queue, activity_logs, app_settings — без изменений концепции.
 *
 * Версия схемы для миграций: см. SCHEMA_VERSION в init + migrate.ts.
 */

/** Используется в init.ts как базовый DDL для пустой БД. */
export const DDL_BASE = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS proxies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  scheme TEXT NOT NULL DEFAULT 'socks5',
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  login TEXT,
  password TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  last_check_status TEXT,
  last_check_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (host, port)
);

CREATE INDEX IF NOT EXISTS idx_proxies_active ON proxies (is_active);

CREATE TABLE IF NOT EXISTS oauth_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  google_client_id TEXT NOT NULL,
  google_client_secret TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_oauth_profiles_label ON oauth_profiles (label);

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proxy_id INTEGER REFERENCES proxies (id) ON DELETE SET NULL,
  oauth_profile_id INTEGER REFERENCES oauth_profiles (id) ON DELETE SET NULL,
  youtube_channel_id TEXT UNIQUE,
  channel_title TEXT,
  default_description TEXT,
  default_tags TEXT,
  made_for_kids INTEGER NOT NULL DEFAULT 0 CHECK (made_for_kids IN (0, 1)),
  default_category_id TEXT NOT NULL DEFAULT '22',
  default_language TEXT NOT NULL DEFAULT 'ru',
  publish_mode TEXT NOT NULL DEFAULT 'manual' CHECK (publish_mode IN ('manual', 'scheduled')),
  schedule_start_at TEXT,
  schedule_videos_per_day INTEGER NOT NULL DEFAULT 4,
  schedule_window_start_hour INTEGER NOT NULL DEFAULT 9,
  schedule_window_end_hour INTEGER NOT NULL DEFAULT 23,
  schedule_randomize_minutes INTEGER NOT NULL DEFAULT 45,
  schedule_timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
  oauth_refresh_token TEXT,
  oauth_access_token TEXT,
  token_expires_at TEXT,
  source_folder_path TEXT,
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_channels_proxy ON channels (proxy_id);
CREATE INDEX IF NOT EXISTS idx_channels_enabled ON channels (is_enabled);

CREATE TABLE IF NOT EXISTS upload_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  original_filename TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN (
      'pending',
      'scheduling',
      'uploading',
      'processing',
      'scheduled',
      'completed',
      'failed',
      'cancelled'
    )
  ),
  scheduled_publish_at TEXT,
  youtube_video_id TEXT,
  privacy_status TEXT NOT NULL DEFAULT 'private',
  title TEXT,
  description TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_queue_channel_status ON upload_queue (channel_id, status);
CREATE INDEX IF NOT EXISTS idx_queue_scheduled ON upload_queue (scheduled_publish_at);

CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER REFERENCES channels (id) ON DELETE SET NULL,
  queue_id INTEGER REFERENCES upload_queue (id) ON DELETE SET NULL,
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
  action_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_logs_channel_created ON activity_logs (channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_logs_created ON activity_logs (created_at);

CREATE TABLE IF NOT EXISTS streamers (
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

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`
