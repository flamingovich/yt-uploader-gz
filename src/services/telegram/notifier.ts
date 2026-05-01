import https from 'node:https'

function postJson(url: string, body: Record<string, unknown>, timeoutMs = 12000): Promise<void> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let responseText = ''
        res.on('data', (c) => {
          responseText += c
        })
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`Telegram HTTP ${res.statusCode}: ${responseText.slice(0, 200)}`))
            return
          }
          resolve()
        })
      }
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Telegram timeout ${timeoutMs}ms`)))
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

export async function sendTelegramNotification(input: {
  botToken: string
  chatId: string
  text: string
  parseMode?: 'HTML' | 'MarkdownV2'
  disableWebPagePreview?: boolean
}): Promise<void> {
  const token = input.botToken.trim()
  const chatId = input.chatId.trim()
  if (!token || !chatId) return
  const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`
  await postJson(url, {
    chat_id: chatId,
    text: input.text,
    parse_mode: input.parseMode,
    disable_web_page_preview: input.disableWebPagePreview ?? true
  })
}
