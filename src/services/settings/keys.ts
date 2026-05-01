/** Ключи в таблице app_settings (значения — строки). */
export const SETTINGS_KEYS = {
  telegram_bot_token: 'telegram_bot_token',
  telegram_chat_id: 'telegram_chat_id',
  google_oauth_client_id: 'google_oauth_client_id',
  google_oauth_client_secret: 'google_oauth_client_secret',
  upload_cooldown_seconds: 'upload_cooldown_seconds'
} as const

export const SETTINGS_KEY_LIST = Object.values(SETTINGS_KEYS)

export type SettingsKey = (typeof SETTINGS_KEYS)[keyof typeof SETTINGS_KEYS]
