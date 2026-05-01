import { contextBridge, ipcRenderer } from 'electron'

const api = {
  bootstrap: (): Promise<{ ok: true }> => ipcRenderer.invoke('app:bootstrap'),
  openExternalUrl: (url: string) =>
    ipcRenderer.invoke('app:openExternalUrl', { url }) as Promise<{ ok: true } | { ok: false; error: string }>,
  dialog: {
    openDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:openDirectory'),
    openFile: (payload?: { filters?: { name: string; extensions: string[] }[] }): Promise<string | null> =>
      ipcRenderer.invoke('dialog:openFile', payload)
  },
  proxy: {
    check: (payload: {
      host?: string
      port?: number
      login?: string | null
      password?: string | null
      persistId?: number
    }) => ipcRenderer.invoke('proxy:check', payload)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (partial: Record<string, string>) => ipcRenderer.invoke('settings:set', partial)
  },
  db: {
    listOAuthProfiles: () => ipcRenderer.invoke('db:oauthProfiles:list'),
    createOAuthProfile: (payload: { label: string; google_client_id: string; google_client_secret: string }) =>
      ipcRenderer.invoke('db:oauthProfiles:create', payload),
    deleteOAuthProfile: (id: number) => ipcRenderer.invoke('db:oauthProfiles:delete', id),
    listProxies: () => ipcRenderer.invoke('db:proxies:list'),
    listChannels: () => ipcRenderer.invoke('db:channels:list'),
    listQueue: (limit?: number) => ipcRenderer.invoke('db:queue:list', limit),
    listLogs: (limit?: number) => ipcRenderer.invoke('db:logs:list', limit),
    createProxy: (payload: {
      name?: string | null
      host: string
      port: number
      login?: string | null
      password?: string | null
    }) => ipcRenderer.invoke('db:proxies:create', payload),
    createBulkProxies: (payload: { lines: string; defaultNamePrefix?: string }) =>
      ipcRenderer.invoke('db:proxies:createBulk', payload),
    createChannel: (payload: {
      proxy_id?: number | null
      oauth_profile_id?: number | null
      channel_title: string
      source_folder_path?: string | null
    }) => ipcRenderer.invoke('db:channels:create', payload),
    deleteChannel: (channelId: number) => ipcRenderer.invoke('db:channels:delete', channelId),
    updateChannelPublishing: (payload: {
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
    }) => ipcRenderer.invoke('db:channels:updatePublishing', payload),
    connectYouTube: (payload: { channelId: number }) => ipcRenderer.invoke('channels:connectYouTube', payload),
    oauthBeginManual: (payload: { channelId: number }) => ipcRenderer.invoke('channels:oauthBeginManual', payload),
    oauthFinishManual: (payload: { flowId: string; callbackUrl: string }) =>
      ipcRenderer.invoke('channels:oauthFinishManual', payload),
    uploadTestVideo: (payload: { channelId: number }) => ipcRenderer.invoke('channels:uploadTestVideo', payload),
    listStreamers: () => ipcRenderer.invoke('db:streamers:list'),
    getStreamer: (id: number) => ipcRenderer.invoke('db:streamers:get', id),
    createStreamer: (payload: { name: string; channel_id: number; proxy_id?: number | null }) =>
      ipcRenderer.invoke('db:streamers:create', payload),
    updateStreamer: (payload: {
      id: number
      name?: string
      channel_id?: number
      proxy_id?: number | null
      rtmp_ingest_url?: string
      rtmp_stream_key?: string
      overlay_path?: string | null
      segments_folder_path?: string | null
      bumper_video_path?: string | null
      ffmpeg_extra_args?: string | null
      youtube_broadcast_id?: string | null
      broadcast_title?: string | null
      broadcast_description?: string | null
      broadcast_tags?: string | null
      broadcast_privacy?: string
      broadcast_category_id?: string
      broadcast_thumb_path?: string | null
    }) => ipcRenderer.invoke('db:streamers:update', payload),
    deleteStreamer: (id: number) => ipcRenderer.invoke('db:streamers:delete', id)
  },
  streamers: {
    start: (payload: { streamerId: number }) => ipcRenderer.invoke('streamers:start', payload),
    stop: (payload: { streamerId: number }) => ipcRenderer.invoke('streamers:stop', payload),
    applyBroadcastMeta: (payload: {
      streamerId: number
      youtube_broadcast_id?: string | null
      broadcast_title?: string | null
      broadcast_description?: string | null
      broadcast_tags?: string | null
      broadcast_privacy?: string
      broadcast_category_id?: string
      broadcast_thumb_path?: string | null
    }) => ipcRenderer.invoke('streamers:applyBroadcastMeta', payload),
    suggestBroadcastId: (payload: { streamerId: number }) =>
      ipcRenderer.invoke('streamers:suggestBroadcastId', payload)
  }
} as const

export type ElectronApi = typeof api

contextBridge.exposeInMainWorld('electronAPI', api)
