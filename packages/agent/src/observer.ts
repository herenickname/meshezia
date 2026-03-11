import { getPeerStates } from './monitor'
import { getAllPeerStats, getTableForIf } from './awg'
// @ts-ignore — JSON import, bundled at compile time
import rootPkg from '../../../package.json'

const VERSION: string = rootPkg.version

interface ObserverConfig {
    port: number
    selfPeerId: string
    selfIpv4: string
    selfName: string
    networkId: string
    memo: string
    /** Called when memo is updated via POST /api/memo */
    onMemoUpdate?: (memo: string) => Promise<void>
}

let config: ObserverConfig

const startedAt = Date.now()

export function startObserver(cfg: ObserverConfig) {
    config = cfg

    Bun.serve({
        port: cfg.port,
        hostname: '127.0.0.1',

        async fetch(req) {
            const url = new URL(req.url)

            if (url.pathname === '/health') {
                return Response.json({
                    status: 'ok',
                    version: VERSION,
                    uptime: Math.floor((Date.now() - startedAt) / 1000),
                    peerId: config.selfPeerId,
                    name: config.selfName
                })
            }

            if (url.pathname === '/api/status') {
                const states = getPeerStates()
                const allStats = await getAllPeerStats()

                const peers = Array.from(states.entries()).map(([peerId, state]) => {
                    const stats = allStats.get(`${state.ifName}\t${state.pubkey}`)
                    const lastHandshake = stats?.latestHandshake ?? 0

                    return {
                        peerId,
                        interface: state.ifName,
                        publicIpv4: state.directEndpoint.split(':')[0],
                        meshIpv4: state.peerIpv4,
                        routingTable: getTableForIf(state.ifName),
                        mode: state.mode,
                        rxAlive: state.rxAlive,
                        lastHandshake,
                        lastHandshakeAge: lastHandshake > 0
                            ? Math.floor(Date.now() / 1000) - lastHandshake
                            : null
                    }
                })

                return Response.json({
                    version: VERSION,
                    self: {
                        peerId: config.selfPeerId,
                        name: config.selfName,
                        meshIpv4: config.selfIpv4,
                        networkId: config.networkId,
                        memo: config.memo,
                        uptime: Math.floor((Date.now() - startedAt) / 1000)
                    },
                    peers
                })
            }

            if (url.pathname === '/api/memo' && req.method === 'POST') {
                try {
                    const body = await req.json() as any
                    if (typeof body.memo !== 'string') {
                        return Response.json({ error: 'memo field required (string)' }, { status: 400 })
                    }
                    config.memo = body.memo
                    if (config.onMemoUpdate) {
                        await config.onMemoUpdate(body.memo)
                    }
                    return Response.json({ ok: true, memo: config.memo })
                } catch {
                    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
                }
            }

            if (url.pathname === '/api/memo' && req.method === 'GET') {
                return Response.json({ memo: config.memo })
            }

            return Response.json({ error: 'Not found' }, { status: 404 })
        }
    })

    console.log(`[observer] listening on :${cfg.port}`)
}
