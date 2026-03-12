import type { ServerWebSocket } from 'bun'
import { RELAY_PEER_ID_LEN } from '@meshezia/shared'
import type { NegotiateMessage } from '@meshezia/shared'

const decoder = new TextDecoder()

export interface WsData {
    peerId: string
    srcIdBytes: Uint8Array | null
}

/** peerId → WebSocket */
const connections = new Map<string, ServerWebSocket<WsData>>()

let onNegotiateMessageCb: ((fromPeerId: string, msg: NegotiateMessage) => void) | null = null
let onDisconnectCb: ((peerId: string) => void) | null = null

/** Register callback for negotiate messages from agents */
export function setOnNegotiateMessage(fn: (fromPeerId: string, msg: NegotiateMessage) => void) {
    onNegotiateMessageCb = fn
}

/** Register callback for WS disconnect (negotiate cleanup) */
export function setOnDisconnect(fn: (peerId: string) => void) {
    onDisconnectCb = fn
}

/** Check if a peer is currently connected via WS */
export function isPeerConnected(peerId: string): boolean {
    return connections.has(peerId)
}

/** Agent message types (agent → server) */
const AGENT_MESSAGE_TYPES = new Set([
    'health-report',
    'probe-relay-ready',
    'probe-relay-result',
    'probe-direct-ready',
    'probe-direct-result',
    'probe-error',
])

export const wsHandler = {
    open(ws: ServerWebSocket<WsData>) {
        const { peerId } = ws.data
        ws.data.srcIdBytes = new TextEncoder().encode(peerId)
        connections.set(peerId, ws)
        console.log(`[relay] ${peerId} connected (${connections.size} total)`)
    },

    message(ws: ServerWebSocket<WsData>, msg: string | Uint8Array) {
        if (typeof msg === 'string') {
            try {
                const parsed = JSON.parse(msg)
                if (parsed.type && AGENT_MESSAGE_TYPES.has(parsed.type)) {
                    onNegotiateMessageCb?.(ws.data.peerId, parsed as NegotiateMessage)
                }
            } catch {
                console.warn(`[relay] invalid JSON from ${ws.data.peerId}`)
            }
            return
        }

        // Binary relay: read only the 36-byte header to determine destination.
        // Then overwrite destination with source in-place — zero payload copy.
        // Frame format: [36-byte dest peerId][opaque AWG payload]
        if (msg.length < RELAY_PEER_ID_LEN) return

        let destPeerId: string
        try {
            destPeerId = decoder.decode(msg.subarray(0, RELAY_PEER_ID_LEN))
        } catch {
            console.warn(`[relay] invalid UTF-8 in relay header from ${ws.data.peerId}`)
            return
        }
        const dest = connections.get(destPeerId)
        if (dest) {
            // Create new buffer with source ID header + payload
            const payload = msg.subarray(RELAY_PEER_ID_LEN)
            const out = new Uint8Array(RELAY_PEER_ID_LEN + payload.length)
            out.set(ws.data.srcIdBytes!, 0)
            out.set(payload, RELAY_PEER_ID_LEN)
            try {
                dest.sendBinary(out)
            } catch (err) {
                console.error(`[relay] sendBinary to ${destPeerId} failed:`, err)
            }
        } else {
            console.log(`[relay] binary: dest ${destPeerId} not connected`)
        }
    },

    close(ws: ServerWebSocket<WsData>) {
        const { peerId } = ws.data
        connections.delete(peerId)
        console.log(`[relay] ${peerId} disconnected (${connections.size} total)`)
        onDisconnectCb?.(peerId)
    }
}

/** Send a text message to a connected peer (server-initiated push) */
export function sendTextToPeer(peerId: string, message: string): boolean {
    const ws = connections.get(peerId)
    if (ws) {
        try {
            ws.sendText(message)
            return true
        } catch (err) {
            console.error(`[relay] sendText to ${peerId} failed:`, err)
            return false
        }
    }
    return false
}

// ─── Application-level heartbeat ───
// Bun's sendPings uses protocol-level PING frames which don't trigger
// the agent's onmessage handler. Without application traffic the agent's
// stale-connection timer (WS_STALE_MS) fires and closes the socket,
// causing the observed 30s flapping cycle.  This heartbeat sends a
// lightweight JSON message that the agent's onmessage *does* see.

const HEARTBEAT_MSG = JSON.stringify({ type: 'ping' })
let heartbeatTimer: ReturnType<typeof setInterval> | null = null

export function startHeartbeat(intervalMs = 20_000) {
    heartbeatTimer = setInterval(() => {
        for (const peerId of connections.keys()) {
            sendTextToPeer(peerId, HEARTBEAT_MSG)
        }
    }, intervalMs)
}

export function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
}
