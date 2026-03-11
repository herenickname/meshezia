import { encodeRelayFrame, decodeRelayFrame } from '@meshezia/shared'
import type { NegotiateMessage } from '@meshezia/shared'
import { handleNegotiateMessage, resetNegotiateState, setNegotiateWsSend } from './negotiate'

const RELAY_BASE_PORT = 41820
/** If no WS message received for this long, assume connection is dead and reconnect */
const WS_STALE_MS = 30_000

interface RelayEntry {
    peerId: string
    localPort: number
    udpSocket: any
    awgListenPort: number
}

const relays = new Map<string, RelayEntry>()
/** Peers currently being probed — relay forwarding paused to prevent AWG roaming */
const probingPeers = new Set<string>()
/** Peers that received relay-forwarded packets since last drain — used by monitor to avoid false direct-alive */
const relayForwardedPeers = new Set<string>()

let ws: WebSocket | null = null
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null
let wsStaleTimer: ReturnType<typeof setInterval> | null = null
let lastWsDataAt = 0
let onPeerRemovedCb: ((peerId: string) => void) | null = null
let onAgentUpdateCb: ((url: string) => void) | null = null

/** Register callback for server-pushed peer removal notifications */
export function setOnPeerRemoved(fn: (peerId: string) => void) {
    onPeerRemovedCb = fn
}

/** Register callback for server-pushed agent update command */
export function setOnAgentUpdate(fn: (url: string) => void) {
    onAgentUpdateCb = fn
}


/** Drain the set of peers that received relay-forwarded packets since last call */
export function drainRelayForwarded(): Set<string> {
    const snapshot = new Set(relayForwardedPeers)
    relayForwardedPeers.clear()
    return snapshot
}

/** Check if WS connection is currently alive */
export function isWsAlive(): boolean {
    return ws?.readyState === WebSocket.OPEN
}

/**
 * Start or update relay proxies for all peers.
 * Each peer gets a local UDP port: 41820 + index.
 */
export interface EnsureRelayProxyOpts {
    peerId: string
    index: number
    awgListenPort: number
}

export async function ensureRelayProxy(opts: EnsureRelayProxyOpts): Promise<number> {
    const { peerId, index, awgListenPort } = opts
    if (relays.has(peerId)) return relays.get(peerId)!.localPort

    const localPort = RELAY_BASE_PORT + index

    const udpSocket = Bun.udpSocket({
        port: localPort,
        hostname: '127.0.0.1',
        socket: {
            data(_socket: any, buf: any, _port: any, _addr: any) {
                if (ws?.readyState === WebSocket.OPEN) {
                    const frame = encodeRelayFrame(peerId, new Uint8Array(buf))
                    ws.send(frame)
                }
            }
        }
    })

    relays.set(peerId, { peerId, localPort, udpSocket: await udpSocket, awgListenPort })
    console.log(`[relay-proxy] ${peerId} → 127.0.0.1:${localPort}`)
    return localPort
}

/** Remove relay proxy for a peer */
export function removeRelayProxy(peerId: string) {
    const entry = relays.get(peerId)
    if (entry?.udpSocket) {
        entry.udpSocket.close()
    }
    relays.delete(peerId)
    probingPeers.delete(peerId)
}

/** Negotiate message types sent by server to agent */
const SERVER_TO_AGENT_TYPES = new Set([
    'probe-relay-serve',
    'probe-relay-check',
    'probe-direct-start',
    'probe-direct-go',
    'probe-verdict',
    'negotiate-abort',
    'force-mode',
])

/**
 * Connect to control plane WebSocket.
 * Handles reconnection automatically.
 */
export interface ConnectWsOpts {
    url: string
    token: string
    selfPeerId: string
}

export function connectWs(opts: ConnectWsOpts) {
    const { url, token, selfPeerId } = opts
    const wsUrl = `${url}?token=${token}&peer=${selfPeerId}`

    function connect() {
        console.log(`[relay-ws] connecting to ${url}`)
        ws = new WebSocket(wsUrl)
        ws.binaryType = 'arraybuffer'

        ws.onopen = () => {
            console.log('[relay-ws] connected')
            lastWsDataAt = Date.now()

            const sendFn = (msg: string) => {
                if (ws?.readyState === WebSocket.OPEN) ws.send(msg)
            }

            // Wire negotiate WS sender
            setNegotiateWsSend(sendFn)

            // Staleness check — detect half-open TCP that kernel hasn't closed
            if (wsStaleTimer) clearInterval(wsStaleTimer)
            wsStaleTimer = setInterval(() => {
                if (ws?.readyState === WebSocket.OPEN && Date.now() - lastWsDataAt > WS_STALE_MS) {
                    console.log('[relay-ws] stale connection detected, closing')
                    ws.close()
                }
            }, 10_000)
        }

        ws.onmessage = (event) => {
            lastWsDataAt = Date.now()
            if (typeof event.data === 'string') {
                try {
                    const msg = JSON.parse(event.data)
                    if (msg.type === 'peer-removed') {
                        console.log(`[relay-ws] peer removed: ${msg.peerId}`)
                        onPeerRemovedCb?.(msg.peerId)
                    } else if (msg.type === 'agent-update') {
                        console.log(`[relay-ws] agent-update command received`)
                        onAgentUpdateCb?.(msg.url)
                    } else if (SERVER_TO_AGENT_TYPES.has(msg.type)) {
                        handleNegotiateMessage(msg as NegotiateMessage)
                    }
                } catch (err) {
                    console.error(`[relay-ws] error handling text message:`, err)
                }
                return
            }

            // Binary: [36-byte source peerId][AWG payload]
            const { destPeerId: srcPeerId, payload } = decodeRelayFrame(
                new Uint8Array(event.data as ArrayBuffer)
            )

            if (probingPeers.has(srcPeerId)) return // drop relay during direct probe

            const entry = relays.get(srcPeerId)
            if (entry?.udpSocket && payload.length > 0) {
                relayForwardedPeers.add(srcPeerId)
                try {
                    entry.udpSocket.send(payload, entry.awgListenPort, '127.0.0.1')
                } catch (err) {
                    console.error(`[relay-proxy] UDP send to :${entry.awgListenPort} failed:`, err)
                }
            }
        }

        ws.onclose = () => {
            console.log('[relay-ws] disconnected, reconnecting in 3s')
            setNegotiateWsSend(() => {})
            probingPeers.clear()
            resetNegotiateState()
            if (wsStaleTimer) { clearInterval(wsStaleTimer); wsStaleTimer = null }
            wsReconnectTimer = setTimeout(connect, 3000)
        }

        ws.onerror = () => {
            ws?.close()
        }
    }

    connect()
}

/** Send a raw string message via WS (used for health reports) */
export function sendWsText(msg: string) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(msg)
}

export function stopWs() {
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer)
    if (wsStaleTimer) clearInterval(wsStaleTimer)
    ws?.close()
}
