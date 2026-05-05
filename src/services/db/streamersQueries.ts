import { getDb } from './init'
import type { StreamerRow } from './types'

export type StreamerListItem = Omit<StreamerRow, 'rtmp_stream_key'> & {
  channel_title: string | null
  proxy_name: string | null
  rtmp_stream_key_masked: string
}

export function listStreamers(): StreamerListItem[] {
  return getDb()
    .prepare(
      `SELECT s.id, s.name, s.channel_id, s.proxy_id, s.rtmp_ingest_url,
              s.overlay_path, s.segments_folder_path, s.bumper_video_path, s.bumper_pad_target_sec, s.ffmpeg_extra_args,
              s.minecraft_prewarm_enabled, s.minecraft_prewarm_chunks_folder, s.minecraft_prewarm_audio_folder, s.minecraft_prewarm_music_path,
              s.youtube_broadcast_id, s.broadcast_title, s.broadcast_description, s.broadcast_tags,
              s.broadcast_privacy, s.broadcast_category_id, s.broadcast_thumb_path,
              s.last_viewer_count, s.last_viewer_checked_at, s.process_status, s.process_error_message,
              s.cycle_state_json, s.created_at, s.updated_at,
              c.channel_title AS channel_title,
              p.name AS proxy_name,
              CASE
                WHEN trim(COALESCE(s.rtmp_stream_key, '')) = '' THEN '—'
                WHEN length(trim(s.rtmp_stream_key)) <= 6 THEN '••••••'
                ELSE '••••••' || substr(trim(s.rtmp_stream_key), -4)
              END AS rtmp_stream_key_masked
       FROM streamers s
       LEFT JOIN channels c ON c.id = s.channel_id
       LEFT JOIN proxies p ON p.id = COALESCE(s.proxy_id, c.proxy_id)
       ORDER BY s.id ASC`
    )
    .all() as StreamerListItem[]
}

export function getStreamerById(id: number): StreamerRow | undefined {
  return getDb().prepare(`SELECT * FROM streamers WHERE id = ?`).get(id) as StreamerRow | undefined
}

export function insertStreamer(input: {
  name: string
  channel_id: number
  proxy_id: number | null
  rtmp_ingest_url?: string
  rtmp_stream_key?: string
}): { id: number } {
  const r = getDb()
    .prepare(
      `INSERT INTO streamers (name, channel_id, proxy_id, rtmp_ingest_url, rtmp_stream_key)
       VALUES (@name, @channel_id, @proxy_id, @rtmp_ingest_url, @rtmp_stream_key)`
    )
    .run({
      name: input.name,
      channel_id: input.channel_id,
      proxy_id: input.proxy_id,
      rtmp_ingest_url: input.rtmp_ingest_url?.trim() ?? '',
      rtmp_stream_key: input.rtmp_stream_key?.trim() ?? ''
    })
  return { id: Number(r.lastInsertRowid) }
}

export function updateStreamer(
  id: number,
  patch: Partial<{
    name: string
    channel_id: number
    proxy_id: number | null
    rtmp_ingest_url: string
    rtmp_stream_key: string
    overlay_path: string | null
    segments_folder_path: string | null
    bumper_video_path: string | null
    bumper_pad_target_sec: number | null
    ffmpeg_extra_args: string | null
    youtube_broadcast_id: string | null
    broadcast_title: string | null
    broadcast_description: string | null
    broadcast_tags: string | null
    broadcast_privacy: string
    broadcast_category_id: string
    broadcast_thumb_path: string | null
    cycle_state_json: string | null
    minecraft_prewarm_enabled: number
    minecraft_prewarm_chunks_folder: string | null
    minecraft_prewarm_audio_folder: string | null
    minecraft_prewarm_music_path: string | null
  }>
): void {
  const allowed = [
    'name',
    'channel_id',
    'proxy_id',
    'rtmp_ingest_url',
    'rtmp_stream_key',
    'overlay_path',
    'segments_folder_path',
    'bumper_video_path',
    'bumper_pad_target_sec',
    'ffmpeg_extra_args',
    'youtube_broadcast_id',
    'broadcast_title',
    'broadcast_description',
    'broadcast_tags',
    'broadcast_privacy',
    'broadcast_category_id',
    'broadcast_thumb_path',
    'cycle_state_json',
    'minecraft_prewarm_enabled',
    'minecraft_prewarm_chunks_folder',
    'minecraft_prewarm_audio_folder',
    'minecraft_prewarm_music_path'
  ] as const
  const sets: string[] = []
  const params: Record<string, unknown> = { id }
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      sets.push(`${k} = @${k}`)
      params[k] = patch[k as keyof typeof patch] as unknown
    }
  }
  if (sets.length === 0) return
  sets.push(`updated_at = datetime('now')`)
  getDb()
    .prepare(`UPDATE streamers SET ${sets.join(', ')} WHERE id = @id`)
    .run(params)
}

export function deleteStreamer(id: number): void {
  getDb().prepare(`DELETE FROM streamers WHERE id = ?`).run(id)
}

export function updateStreamerProcessState(
  id: number,
  status: string,
  errorMessage: string | null
): void {
  getDb()
    .prepare(
      `UPDATE streamers SET process_status = ?, process_error_message = ?, updated_at = datetime('now') WHERE id = ?`
    )
    .run(status, errorMessage, id)
}

export function updateStreamerViewers(id: number, count: number | null): void {
  getDb()
    .prepare(
      `UPDATE streamers SET last_viewer_count = ?, last_viewer_checked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    )
    .run(count, id)
}
