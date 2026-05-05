/// <reference types="vite/client" />

type ChannelListItem = {
  id: number
  proxy_id: number | null
  oauth_profile_id: number | null
  ads_profile_id: string | null
  /** Имя профиля ADS Power (Local API), для отображения. */
  ads_profile_name: string | null
  oauth_profile_label: string | null
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
  last_uploaded_at: string | null
  last_uploaded_video_id: string | null
  next_scheduled_publish_at: string | null
  last_queue_activity_at: string | null
  has_live_stream: number
  upload_cooldown_seconds: number
  source_folder_path: string | null
  is_enabled: number
  created_at: string
  updated_at: string
}

type OAuthProfileListItem = {
  id: number
  label: string
  google_client_id: string
  channel_count: number
}

type ProxyListItem = {
  id: number
  name: string | null
  scheme: string
  host: string
  port: number
  login: string | null
  is_active: number
  last_check_status: string | null
  last_check_at: string | null
  created_at: string
  updated_at: string
}

type ActivityLogItem = {
  id: number
  channel_id: number | null
  queue_id: number | null
  level: 'info' | 'warn' | 'error'
  action_type: string
  message: string
  metadata_json: string | null
  created_at: string
  channel_name?: string | null
}

type UploadQueueItem = {
  id: number
  channel_id: number
  file_path: string
  original_filename: string | null
  status: 'pending' | 'scheduling' | 'uploading' | 'processing' | 'scheduled' | 'completed' | 'failed' | 'cancelled'
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

type Socks5CheckResult =
  | {
      ok: true
      ip: string
      country: string
      country_code?: string
      city: string
      region: string
      isp?: string
    }
  | { ok: false; error: string }

type CreateOk<T> = { ok: true; data: T }
type CreateErr = { ok: false; error: string; code?: string; debugLog?: string }
type CreateResult<T> = CreateOk<T> | CreateErr

declare global {
  interface Window {
    electronAPI: {
      bootstrap(): Promise<{ ok: true }>
      onDataChanged(cb: (payload: { actionType: string; at: number }) => void): () => void
      openExternalUrl(url: string): Promise<{ ok: true } | { ok: false; error: string }>
      dialog: {
        openDirectory(): Promise<string | null>
        openFile(payload?: { filters?: { name: string; extensions: string[] }[] }): Promise<string | null>
      }
      proxy: {
        check(payload: {
          host?: string
          port?: number
          login?: string | null
          password?: string | null
          persistId?: number
        }): Promise<Socks5CheckResult>
      }
      settings: {
        get(): Promise<Record<string, string>>
        set(partial: Record<string, string>): Promise<{ ok: true }>
      }
      db: {
        listOAuthProfiles(): Promise<OAuthProfileListItem[]>
        createOAuthProfile(payload: {
          label: string
          google_client_id: string
          google_client_secret: string
        }): Promise<CreateResult<{ id: number }>>
        deleteOAuthProfile(id: number): Promise<CreateResult<{ id: number }>>
        listProxies(): Promise<ProxyListItem[]>
        listChannels(): Promise<ChannelListItem[]>
        listQueue(limit?: number): Promise<UploadQueueItem[]>
        listLogs(limit?: number): Promise<ActivityLogItem[]>
        createProxy(payload: {
          name?: string | null
          host: string
          port: number
          login?: string | null
          password?: string | null
        }): Promise<CreateResult<{ id: number }>>
        createBulkProxies(payload: {
          lines: string
          defaultNamePrefix?: string
        }): Promise<
          CreateResult<{
            total: number
            created: number
            failed: number
            errors: string[]
          }>
        >
        createChannel(payload: {
          proxy_id?: number | null
          oauth_profile_id?: number | null
          ads_profile_id?: string | null
          channel_title: string
          source_folder_path?: string | null
        }): Promise<CreateResult<{ id: number }>>
        deleteChannel(channelId: number): Promise<CreateResult<{ channelId: number }>>
        updateChannelPublishing(payload: {
          channelId: number
          default_description?: string | null
          default_tags?: string | null
          made_for_kids?: number
          default_category_id?: string
          default_language?: string
          publish_mode?: 'manual' | 'scheduled'
          schedule_start_at?: string | null
          schedule_videos_per_day?: number
          schedule_window_start_hour?: number
          schedule_window_end_hour?: number
          schedule_randomize_minutes?: number
          schedule_timezone?: string
          source_folder_path?: string | null
          upload_cooldown_seconds?: number
          ads_profile_id?: string | null
        }): Promise<CreateResult<{ channelId: number }>>
        connectYouTube(payload: { channelId: number }): Promise<
          | CreateResult<{ youtube_channel_id: string; channel_title: string }>
          | { ok: false; error: string }
        >
        oauthBeginManual(payload: { channelId: number }): Promise<
          | CreateResult<{ flowId: string; authUrl: string }>
          | { ok: false; error: string }
        >
        oauthBeginManualInAds(payload: { channelId: number }): Promise<
          | CreateResult<{ flowId: string; authUrl: string }>
          | { ok: false; error: string }
        >
        syncProxyFromAds(payload: { channelId: number }): Promise<
          | CreateResult<{ mode: 'imported' | 'linked_existing' | 'no_proxy'; proxy_id: number | null; summary: string }>
          | { ok: false; error: string }
        >
        oauthWaitManual(payload: { flowId: string; timeoutMs?: number }): Promise<
          | CreateResult<{ channelId: number; youtube_channel_id: string; channel_title: string }>
          | { ok: false; error: string }
        >
        oauthFinishManual(payload: { flowId: string; callbackUrl: string }): Promise<
          | CreateResult<{ channelId: number; youtube_channel_id: string; channel_title: string }>
          | { ok: false; error: string }
        >
        uploadTestVideo(payload: { channelId: number }): Promise<
          | CreateResult<{
              uploaded: number
              failed: number
              selected: number
              daily_used: number
              daily_limit: number
              videoIds: string[]
            }>
          | { ok: false; error: string }
        >
        listStreamers(): Promise<StreamerListItem[]>
        getStreamer(id: number): Promise<StreamerDetailRow | null>
        createStreamer(payload: {
          name: string
          channel_id: number
          proxy_id?: number | null
        }): Promise<CreateResult<{ id: number }>>
        updateStreamer(payload: {
          id: number
          name?: string
          channel_id?: number
          proxy_id?: number | null
          rtmp_ingest_url?: string
          rtmp_stream_key?: string
          overlay_path?: string | null
          segments_folder_path?: string | null
          bumper_video_path?: string | null
          bumper_pad_target_sec?: number | null
          ffmpeg_extra_args?: string | null
          youtube_broadcast_id?: string | null
          broadcast_title?: string | null
          broadcast_description?: string | null
          broadcast_tags?: string | null
          broadcast_privacy?: string
          broadcast_category_id?: string
          broadcast_thumb_path?: string | null
          minecraft_prewarm_enabled?: number | boolean
          minecraft_prewarm_chunks_folder?: string | null
          minecraft_prewarm_audio_folder?: string | null
          minecraft_prewarm_music_path?: string | null
        }): Promise<CreateResult<{ id: number }>>
        deleteStreamer(id: number): Promise<CreateResult<{ id: number }>>
      }
      streamers: {
        start(payload: { streamerId: number }): Promise<CreateResult<Record<string, never>>>
        stop(payload: { streamerId: number }): Promise<CreateResult<{ streamerId: number }>>
        applyBroadcastMeta(payload: {
          streamerId: number
          youtube_broadcast_id?: string | null
          broadcast_title?: string | null
          broadcast_description?: string | null
          broadcast_tags?: string | null
          broadcast_privacy?: string
          broadcast_category_id?: string
          broadcast_thumb_path?: string | null
        }): Promise<CreateResult<{ streamerId: number; debugLog: string }>>
        suggestBroadcastId(payload: {
          streamerId: number
        }): Promise<
          | CreateResult<{
              broadcastId: string
              title: string
              lifeCycleStatus: string | null
            }>
          | { ok: false; error: string }
        >
      }
      ai: {
        generateChannelMeta(payload: {
          channelId?: number
          kind: 'description' | 'tags'
          topicPrompt: string
          language?: string
          category?: string
          madeForKids?: boolean
        }): Promise<
          | CreateResult<{ text: string; kind: 'description' | 'tags' }>
          | { ok: false; error: string }
        >
      }
    }
  }
}

type StreamerDetailRow = {
  id: number
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
  minecraft_prewarm_enabled: number
  minecraft_prewarm_chunks_folder: string | null
  minecraft_prewarm_audio_folder: string | null
  minecraft_prewarm_music_path: string | null
  last_viewer_count: number | null
  last_viewer_checked_at: string | null
  process_status: string
  process_error_message: string | null
  cycle_state_json: string | null
  created_at: string
  updated_at: string
}

type StreamerListItem = {
  id: number
  name: string
  channel_id: number
  proxy_id: number | null
  rtmp_ingest_url: string
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
  minecraft_prewarm_enabled: number
  minecraft_prewarm_chunks_folder: string | null
  minecraft_prewarm_audio_folder: string | null
  minecraft_prewarm_music_path: string | null
  last_viewer_count: number | null
  last_viewer_checked_at: string | null
  process_status: string
  process_error_message: string | null
  cycle_state_json: string | null
  created_at: string
  updated_at: string
  channel_title: string | null
  proxy_name: string | null
  rtmp_stream_key_masked: string
  /** Только пока сессия стрима активна: суммарный битрейт из ffmpeg (kbits/s). */
  runtime_video_bitrate_kbps?: number | null
  /** Только пока сессия активна: RTMP идёт через локальный SOCKS-relay. */
  runtime_rtmp_via_proxy?: boolean
}

export {}
