import type { ActivityLogRow, ChannelRow, OAuthProfileRow, ProxyRow, UploadQueueRow } from './types'
import { getDb } from './init'
import { SETTINGS_KEY_LIST } from '../settings/keys'
import { MAX_CHANNELS_PER_OAUTH_PROFILE } from '../google/oauthProfileLimits'

export function listProxies(): Omit<ProxyRow, 'password'>[] {
  const rows = getDb()
    .prepare(
      `SELECT id, name, scheme, host, port, login, is_active, last_check_status, last_check_at, created_at, updated_at
       FROM proxies ORDER BY id ASC`
    )
    .all() as Omit<ProxyRow, 'password'>[]
  return rows
}

export function getProxyById(id: number): ProxyRow | undefined {
  return getDb().prepare(`SELECT * FROM proxies WHERE id = ?`).get(id) as ProxyRow | undefined
}

export function getProxyByHostPort(host: string, port: number): ProxyRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM proxies WHERE host = ? AND port = ? LIMIT 1`)
    .get(host.trim(), port) as ProxyRow | undefined
}

export function updateProxyCheckStatus(id: number, statusJson: string): void {
  getDb()
    .prepare(
      `UPDATE proxies SET last_check_status = ?, last_check_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    )
    .run(statusJson, id)
}

export function updateProxyName(id: number, name: string | null): void {
  getDb()
    .prepare(`UPDATE proxies SET name = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(name?.trim() || null, id)
}

export function insertProxy(input: {
  name?: string | null
  host: string
  port: number
  login?: string | null
  password?: string | null
}): { id: number } {
  const r = getDb()
    .prepare(
      `INSERT INTO proxies (name, scheme, host, port, login, password)
       VALUES (@name, 'socks5', @host, @port, @login, @password)`
    )
    .run({
      name: input.name ?? null,
      host: input.host,
      port: input.port,
      login: input.login ?? null,
      password: input.password ?? null
    })
  return { id: Number(r.lastInsertRowid) }
}

export function deleteProxy(id: number): { ok: true } | { ok: false; error: string } {
  const r = getDb().prepare(`DELETE FROM proxies WHERE id = ?`).run(id)
  if (r.changes < 1) return { ok: false, error: 'Прокси не найден' }
  return { ok: true }
}

export type ChannelListItem = Omit<
  ChannelRow,
  'oauth_refresh_token' | 'oauth_access_token' | 'token_expires_at'
> & {
  oauth_profile_label: string | null
  last_uploaded_at: string | null
  last_uploaded_video_id: string | null
  /** Ближайшее будущее scheduled_publish_at в очереди (не failed/cancelled). */
  next_scheduled_publish_at: string | null
  /**
   * Макс. дата среди: последняя публикация (completed_at) и все запланированные слоты в очереди
   * (scheduled_publish_at для не failed/cancelled) — чтобы учитывать «дальнюю» отложку.
   */
  last_queue_activity_at: string | null
  /** Есть стример в starting/live на этом канале. */
  has_live_stream: number
}

export function listChannels(): ChannelListItem[] {
  return getDb()
    .prepare(
      `SELECT c.id, c.proxy_id, c.oauth_profile_id, c.ads_profile_id, c.ads_profile_name, c.youtube_channel_id, c.channel_title,
              c.default_description, c.default_tags, c.made_for_kids, c.default_category_id, c.default_language, c.publish_mode,
              c.schedule_start_at, c.schedule_videos_per_day, c.schedule_window_start_hour,
              c.schedule_window_end_hour,
              COALESCE(c.schedule_window_start_mins, c.schedule_window_start_hour * 60) AS schedule_window_start_mins,
              COALESCE(c.schedule_window_end_mins, c.schedule_window_end_hour * 60 + 59) AS schedule_window_end_mins,
              c.schedule_randomize_minutes, c.schedule_timezone,
              c.source_folder_path, c.is_enabled, c.upload_cooldown_seconds, c.oauth_status, c.stream_preview_layout_json, c.stream_preview_layout_white_json, c.created_at, c.updated_at, p.label AS oauth_profile_label,
              (
                SELECT q.completed_at
                FROM upload_queue q
                WHERE q.channel_id = c.id
                  AND q.completed_at IS NOT NULL
                ORDER BY datetime(q.completed_at) DESC
                LIMIT 1
              ) AS last_uploaded_at,
              (
                SELECT q.youtube_video_id
                FROM upload_queue q
                WHERE q.channel_id = c.id
                  AND q.completed_at IS NOT NULL
                ORDER BY datetime(q.completed_at) DESC
                LIMIT 1
              ) AS last_uploaded_video_id,
              (
                SELECT q.scheduled_publish_at
                FROM upload_queue q
                WHERE q.channel_id = c.id
                  AND trim(COALESCE(q.scheduled_publish_at, '')) != ''
                  AND unixepoch(trim(q.scheduled_publish_at)) > unixepoch('now')
                  AND q.status NOT IN ('failed', 'cancelled')
                ORDER BY unixepoch(trim(q.scheduled_publish_at)) ASC NULLS LAST,
                         trim(q.scheduled_publish_at) ASC
                LIMIT 1
              ) AS next_scheduled_publish_at,
              (
                SELECT MAX(dt)
                FROM (
                  SELECT trim(q.completed_at) AS dt
                  FROM upload_queue q
                  WHERE q.channel_id = c.id
                    AND q.completed_at IS NOT NULL
                    AND trim(COALESCE(q.completed_at, '')) != ''
                  UNION ALL
                  SELECT trim(q.scheduled_publish_at) AS dt
                  FROM upload_queue q
                  WHERE q.channel_id = c.id
                    AND trim(COALESCE(q.scheduled_publish_at, '')) != ''
                    AND q.status NOT IN ('failed', 'cancelled')
                ) u
                WHERE u.dt IS NOT NULL AND length(trim(u.dt)) > 0
              ) AS last_queue_activity_at,
              (
                SELECT CASE WHEN EXISTS (
                  SELECT 1 FROM streamers s
                  WHERE s.channel_id = c.id AND s.process_status IN ('starting', 'live')
                ) THEN 1 ELSE 0 END
              ) AS has_live_stream
       FROM channels c
       LEFT JOIN oauth_profiles p ON p.id = c.oauth_profile_id
       ORDER BY c.id ASC`
    )
    .all() as ChannelListItem[]
}

export function updateChannelPublishingSettings(input: {
  channel_id: number
  ads_profile_id: string | null
  ads_profile_name: string | null
  default_description: string | null
  default_tags: string | null
  made_for_kids: number
  default_category_id: string
  default_language: string
  publish_mode: 'manual' | 'scheduled'
  schedule_start_at: string | null
  schedule_videos_per_day: number
  schedule_window_start_hour: number
  schedule_window_end_hour: number
  schedule_window_start_mins: number
  schedule_window_end_mins: number
  schedule_randomize_minutes: number
  schedule_timezone: string
  source_folder_path: string | null
  upload_cooldown_seconds: number
}): void {
  getDb()
    .prepare(
      `UPDATE channels
       SET default_description = @default_description,
           default_tags = @default_tags,
           made_for_kids = @made_for_kids,
           default_category_id = @default_category_id,
           default_language = @default_language,
           publish_mode = @publish_mode,
           schedule_start_at = @schedule_start_at,
           schedule_videos_per_day = @schedule_videos_per_day,
           schedule_window_start_hour = @schedule_window_start_hour,
           schedule_window_end_hour = @schedule_window_end_hour,
           schedule_window_start_mins = @schedule_window_start_mins,
           schedule_window_end_mins = @schedule_window_end_mins,
           schedule_randomize_minutes = @schedule_randomize_minutes,
           schedule_timezone = @schedule_timezone,
           source_folder_path = @source_folder_path,
           upload_cooldown_seconds = @upload_cooldown_seconds,
           ads_profile_id = @ads_profile_id,
           ads_profile_name = @ads_profile_name,
           updated_at = datetime('now')
       WHERE id = @channel_id`
    )
    .run({
      channel_id: input.channel_id,
      default_description: input.default_description?.trim() || null,
      default_tags: input.default_tags?.trim() || null,
      made_for_kids: input.made_for_kids ? 1 : 0,
      default_category_id: input.default_category_id.trim(),
      default_language: input.default_language.trim(),
      publish_mode: input.publish_mode,
      schedule_start_at: input.schedule_start_at || null,
      schedule_videos_per_day: input.schedule_videos_per_day,
      schedule_window_start_hour: input.schedule_window_start_hour,
      schedule_window_end_hour: input.schedule_window_end_hour,
      schedule_window_start_mins: input.schedule_window_start_mins,
      schedule_window_end_mins: input.schedule_window_end_mins,
      schedule_randomize_minutes: input.schedule_randomize_minutes,
      schedule_timezone: input.schedule_timezone.trim() || 'Europe/Moscow',
      source_folder_path: input.source_folder_path?.trim() || null,
      upload_cooldown_seconds: input.upload_cooldown_seconds,
      ads_profile_id: input.ads_profile_id?.trim() || null,
      ads_profile_name: input.ads_profile_name?.trim() || null
    })
}

export function updateChannelAdsProfileName(channelId: number, name: string | null): void {
  getDb()
    .prepare(
      `UPDATE channels
       SET ads_profile_name = @name,
           updated_at = datetime('now')
       WHERE id = @channel_id`
    )
    .run({
      channel_id: channelId,
      name: name?.trim() || null
    })
}

export function insertChannel(input: {
  proxy_id?: number | null
  oauth_profile_id?: number | null
  ads_profile_id?: string | null
  channel_title: string
  source_folder_path?: string | null
}): { id: number } {
  const r = getDb()
    .prepare(
      `INSERT INTO channels (proxy_id, oauth_profile_id, ads_profile_id, channel_title, source_folder_path, updated_at)
       VALUES (@proxy_id, @oauth_profile_id, @ads_profile_id, @channel_title, @source_folder_path, datetime('now'))`
    )
    .run({
      proxy_id: input.proxy_id ?? null,
      oauth_profile_id: input.oauth_profile_id ?? null,
      ads_profile_id: input.ads_profile_id?.trim() || null,
      channel_title: input.channel_title.trim(),
      source_folder_path: input.source_folder_path?.trim() || null
    })
  return { id: Number(r.lastInsertRowid) }
}

export function deleteChannel(id: number): void {
  getDb().prepare(`DELETE FROM channels WHERE id = ?`).run(id)
}

export function getChannelById(id: number): ChannelRow | undefined {
  return getDb().prepare(`SELECT * FROM channels WHERE id = ?`).get(id) as ChannelRow | undefined
}

export function updateChannelProxyBinding(channelId: number, proxyId: number | null): void {
  getDb()
    .prepare(
      `UPDATE channels
       SET proxy_id = @proxy_id,
           updated_at = datetime('now')
       WHERE id = @channel_id`
    )
    .run({
      channel_id: channelId,
      proxy_id: proxyId
    })
}

export function updateChannelOAuthData(input: {
  channelId: number
  youtube_channel_id?: string | null
  channel_title?: string | null
  oauth_access_token?: string | null
  oauth_refresh_token?: string | null
  oauth_status?: 'unknown' | 'ok' | 'invalid'
  token_expires_at?: string | null
}): void {
  getDb()
    .prepare(
      `UPDATE channels
       SET youtube_channel_id = COALESCE(@youtube_channel_id, youtube_channel_id),
           channel_title = COALESCE(@channel_title, channel_title),
           oauth_access_token = COALESCE(@oauth_access_token, oauth_access_token),
           oauth_refresh_token = COALESCE(@oauth_refresh_token, oauth_refresh_token),
           oauth_status = COALESCE(@oauth_status, oauth_status),
           token_expires_at = COALESCE(@token_expires_at, token_expires_at),
           updated_at = datetime('now')
       WHERE id = @channel_id`
    )
    .run({
      channel_id: input.channelId,
      youtube_channel_id: input.youtube_channel_id ?? null,
      channel_title: input.channel_title ?? null,
      oauth_access_token: input.oauth_access_token ?? null,
      oauth_refresh_token: input.oauth_refresh_token ?? null,
      oauth_status: input.oauth_status ?? null,
      token_expires_at: input.token_expires_at ?? null
    })
}

export function updateChannelStreamPreviewLayout(
  channelId: number,
  layoutJson: string | null,
  type: 'casino' | 'white_prewarm' = 'casino'
): void {
  const col = type === 'white_prewarm' ? 'stream_preview_layout_white_json' : 'stream_preview_layout_json'
  getDb()
    .prepare(
      `UPDATE channels
       SET ${col} = @layout,
           updated_at = datetime('now')
       WHERE id = @channel_id`
    )
    .run({
      channel_id: channelId,
      layout: layoutJson
    })
}

export function updateChannelBumperPreviewLayout(channelId: number, layoutJson: string | null): void {
  getDb()
    .prepare(
      `UPDATE channels
       SET stream_preview_bumper_layout_json = @layout,
           updated_at = datetime('now')
       WHERE id = @channel_id`
    )
    .run({
      channel_id: channelId,
      layout: layoutJson
    })
}

export type OAuthProfileListItem = {
  id: number
  label: string
  google_client_id: string
  channel_count: number
}

export function listOAuthProfiles(): OAuthProfileListItem[] {
  return getDb()
    .prepare(
      `SELECT p.id, p.label, p.google_client_id,
              (SELECT COUNT(*) FROM channels c WHERE c.oauth_profile_id = p.id) AS channel_count
       FROM oauth_profiles p
       ORDER BY p.id ASC`
    )
    .all() as OAuthProfileListItem[]
}

export function getOAuthProfileById(id: number): OAuthProfileRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM oauth_profiles WHERE id = ?`)
    .get(id) as OAuthProfileRow | undefined
}

export function countChannelsForOAuthProfile(oauthProfileId: number): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM channels WHERE oauth_profile_id = ?`)
    .get(oauthProfileId) as { n: number }
  return row.n
}

export function insertOAuthProfile(input: {
  label: string
  google_client_id: string
  google_client_secret: string
}): { id: number } {
  const r = getDb()
    .prepare(
      `INSERT INTO oauth_profiles (label, google_client_id, google_client_secret, updated_at)
       VALUES (@label, @google_client_id, @google_client_secret, datetime('now'))`
    )
    .run({
      label: input.label.trim(),
      google_client_id: input.google_client_id.trim(),
      google_client_secret: input.google_client_secret
    })
  return { id: Number(r.lastInsertRowid) }
}

export function deleteOAuthProfile(id: number): { ok: true } | { ok: false; error: string } {
  const n = countChannelsForOAuthProfile(id)
  if (n > 0) {
    return { ok: false, error: `К этому профилю привязано каналов: ${n}. Сначала переназначьте каналы.` }
  }
  getDb().prepare(`DELETE FROM oauth_profiles WHERE id = ?`).run(id)
  return { ok: true }
}

export function listUploadQueue(limit = 100): UploadQueueRow[] {
  return getDb()
    .prepare(
      `SELECT q.*, c.channel_title AS channel_name
       FROM upload_queue q
       LEFT JOIN channels c ON c.id = q.channel_id
       ORDER BY datetime(q.created_at) DESC
       LIMIT ?`
    )
    .all(limit) as UploadQueueRow[]
}

export function insertUploadQueueItem(input: {
  channel_id: number
  file_path: string
  original_filename?: string | null
  status?: UploadQueueRow['status']
  scheduled_publish_at?: string | null
  privacy_status?: string
  title?: string | null
  description?: string | null
}): { id: number } {
  const r = getDb()
    .prepare(
      `INSERT INTO upload_queue (
         channel_id, file_path, original_filename, status, scheduled_publish_at, privacy_status, title, description, updated_at
       )
       VALUES (
         @channel_id, @file_path, @original_filename, @status, @scheduled_publish_at, @privacy_status, @title, @description, datetime('now')
       )`
    )
    .run({
      channel_id: input.channel_id,
      file_path: input.file_path,
      original_filename: input.original_filename ?? null,
      status: input.status ?? 'pending',
      scheduled_publish_at: input.scheduled_publish_at ?? null,
      privacy_status: input.privacy_status ?? 'private',
      title: input.title ?? null,
      description: input.description ?? null
    })
  return { id: Number(r.lastInsertRowid) }
}

export function updateUploadQueueStatus(input: {
  id: number
  status: UploadQueueRow['status']
  youtube_video_id?: string | null
  error_message?: string | null
  completed_at?: string | null
}): void {
  getDb()
    .prepare(
      `UPDATE upload_queue
       SET status = @status,
           youtube_video_id = COALESCE(@youtube_video_id, youtube_video_id),
           error_message = @error_message,
           completed_at = @completed_at,
           updated_at = datetime('now')
       WHERE id = @id`
    )
    .run({
      id: input.id,
      status: input.status,
      youtube_video_id: input.youtube_video_id ?? null,
      error_message: input.error_message ?? null,
      completed_at: input.completed_at ?? null
    })
}

export function countCompletedUploadsToday(channelId: number): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n
       FROM upload_queue
       WHERE channel_id = ?
         AND status = 'completed'
         AND date(completed_at, 'localtime') = date('now', 'localtime')`
    )
    .get(channelId) as { n: number }
  return row.n
}

export function listActivityLogs(limit = 200): ActivityLogRow[] {
  return getDb()
    .prepare(
      `SELECT l.*, c.channel_title AS channel_name
       FROM activity_logs l
       LEFT JOIN channels c ON c.id = l.channel_id
       ORDER BY datetime(l.created_at) DESC
       LIMIT ?`
    )
    .all(limit) as ActivityLogRow[]
}

export function appendActivityLog(entry: {
  channel_id?: number | null
  queue_id?: number | null
  level: 'info' | 'warn' | 'error'
  action_type: string
  message: string
  metadata?: Record<string, unknown> | null
}): void {
  getDb()
    .prepare(
      `INSERT INTO activity_logs (channel_id, queue_id, level, action_type, message, metadata_json)
       VALUES (@channel_id, @queue_id, @level, @action_type, @message, @metadata_json)`
    )
    .run({
      channel_id: entry.channel_id ?? null,
      queue_id: entry.queue_id ?? null,
      level: entry.level,
      action_type: entry.action_type,
      message: entry.message,
      metadata_json: entry.metadata ? JSON.stringify(entry.metadata) : null
    })
}

export function getAppSettings(): Record<string, string> {
  const db = getDb()
  const stmt = db.prepare(`SELECT value FROM app_settings WHERE key = ?`)
  const out: Record<string, string> = {}
  for (const key of SETTINGS_KEY_LIST) {
    const row = stmt.get(key) as { value: string } | undefined
    out[key] = row?.value ?? ''
  }
  return out
}

export function setAppSettings(partial: Record<string, string>): void {
  const db = getDb()
  const stmt = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `)
  for (const [key, value] of Object.entries(partial)) {
    if (!SETTINGS_KEY_LIST.includes(key as (typeof SETTINGS_KEY_LIST)[number])) continue
    stmt.run(key, value)
  }
}
