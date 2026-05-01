export type UploadQueueStatus =
  | 'pending'
  | 'scheduling'
  | 'uploading'
  | 'processing'
  | 'scheduled'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type LogLevel = 'info' | 'warn' | 'error'

export interface ProxyRow {
  id: number
  name: string | null
  scheme: string
  host: string
  port: number
  login: string | null
  password: string | null
  is_active: number
  last_check_status: string | null
  last_check_at: string | null
  created_at: string
  updated_at: string
}

export interface OAuthProfileRow {
  id: number
  label: string
  google_client_id: string
  google_client_secret: string
  created_at: string
  updated_at: string
}

export interface ChannelRow {
  id: number
  proxy_id: number | null
  oauth_profile_id: number | null
  youtube_channel_id: string | null
  channel_title: string | null
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
  schedule_randomize_minutes: number
  schedule_timezone: string
  oauth_refresh_token: string | null
  oauth_access_token: string | null
  token_expires_at: string | null
  source_folder_path: string | null
  is_enabled: number
  created_at: string
  updated_at: string
}

export interface UploadQueueRow {
  id: number
  channel_id: number
  file_path: string
  original_filename: string | null
  status: UploadQueueStatus
  scheduled_publish_at: string | null
  youtube_video_id: string | null
  privacy_status: string
  title: string | null
  description: string | null
  error_message: string | null
  attempts: number
  max_attempts: number
  created_at: string
  updated_at: string
  completed_at: string | null
  channel_name?: string | null
}

export interface ActivityLogRow {
  id: number
  channel_id: number | null
  queue_id: number | null
  level: LogLevel
  action_type: string
  message: string
  metadata_json: string | null
  created_at: string
  channel_name?: string | null
}

export type StreamerProcessStatus = 'stopped' | 'starting' | 'live' | 'error'

export interface StreamerRow {
  id: number
  name: string
  channel_id: number
  proxy_id: number | null
  rtmp_ingest_url: string
  rtmp_stream_key: string
  overlay_path: string | null
  segments_folder_path: string | null
  bumper_video_path: string | null
  ffmpeg_extra_args: string | null
  youtube_broadcast_id: string | null
  broadcast_title: string | null
  broadcast_description: string | null
  broadcast_tags: string | null
  broadcast_privacy: string
  broadcast_category_id: string
  broadcast_thumb_path: string | null
  last_viewer_count: number | null
  last_viewer_checked_at: string | null
  process_status: string
  process_error_message: string | null
  cycle_state_json: string | null
  created_at: string
  updated_at: string
}
