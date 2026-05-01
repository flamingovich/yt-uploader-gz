import net from 'node:net'
import { SocksClient } from 'socks'
import type { ProxyRow } from '@services/db/types'

export async function startSocksTcpRelay(input: {
  proxy: ProxyRow
  destHost: string
  destPort: number
}): Promise<{ localPort: number; close: () => Promise<void> }> {
  const server = net.createServer()

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const addr = server.address()
  const localPort = typeof addr === 'object' && addr ? addr.port : 0
  if (!localPort) {
    await new Promise<void>((r) => server.close(() => r()))
    throw new Error('Не удалось выделить локальный порт для RTMP-туннеля')
  }

  server.on('connection', (client) => {
    void (async () => {
      try {
        const established = await SocksClient.createConnection({
          command: 'connect',
          proxy: {
            host: input.proxy.host.trim(),
            port: input.proxy.port,
            type: 5,
            userId: input.proxy.login?.trim() || undefined,
            password: input.proxy.password ?? undefined
          },
          destination: {
            host: input.destHost,
            port: input.destPort
          },
          timeout: 120_000
        })
        const remote = established.socket
        client.setNoDelay(true)
        remote.setNoDelay(true)
        client.pipe(remote)
        remote.pipe(client)
        const onErr = (): void => {
          try {
            client.destroy()
          } catch {
            /* ignore */
          }
          try {
            remote.destroy()
          } catch {
            /* ignore */
          }
        }
        client.on('error', onErr)
        remote.on('error', onErr)
      } catch {
        client.destroy()
      }
    })()
  })

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      server.close(() => resolve())
    })

  return { localPort, close }
}
