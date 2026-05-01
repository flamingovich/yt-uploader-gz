import { getAppSettings, getChannelById, getOAuthProfileById, getProxyById } from '@services/db/queries'
import { SETTINGS_KEYS } from '@services/settings/keys'
import type { ChannelRow, ProxyRow } from '@services/db/types'

export function getOAuthClientCredentialsForChannel(channelId: number): {
  clientId: string
  clientSecret: string
  channel: ChannelRow
  proxy: ProxyRow | undefined
} {
  const channel = getChannelById(channelId)
  if (!channel) {
    throw new Error('Канал не найден')
  }
  const proxy = channel.proxy_id ? getProxyById(channel.proxy_id) : undefined
  if (channel.proxy_id && !proxy) {
    throw new Error('Прокси канала не найден')
  }

  if (channel.oauth_profile_id) {
    const profile = getOAuthProfileById(channel.oauth_profile_id)
    if (!profile) throw new Error('OAuth-профиль не найден')
    return {
      clientId: profile.google_client_id,
      clientSecret: profile.google_client_secret,
      channel,
      proxy
    }
  }

  const settings = getAppSettings()
  const clientId = settings[SETTINGS_KEYS.google_oauth_client_id] ?? ''
  const clientSecret = settings[SETTINGS_KEYS.google_oauth_client_secret] ?? ''
  if (!clientId || !clientSecret) {
    throw new Error('Нет OAuth-профиля у канала и не заполнены единые Google OAuth поля в настройках')
  }
  return { clientId, clientSecret, channel, proxy }
}
