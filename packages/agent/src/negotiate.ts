import { execSafe } from './exec'
import { getPeerStates, freezePeer, unfreezePeer, clearAllFrozen, setPeerMode } from './monitor'
import type { NegotiateMessage } from '@meshezia/shared'

// ─── Dependencies ───

let wsSend: (msg: string) => void = () => {}
let selfMeshIpv4 = ''
let selfPubkey = ''

export function setNegotiateWsSend(fn: (msg: string) => void) { wsSend = fn }
export function setNegotiateSelfIp(ip: string) { selfMeshIpv4 = ip }
export function setNegotiateSelfPubkey(pk: string) { selfPubkey = pk }

// ─── Probe state ───

/** Active TCP probe server (one at a time) */
let tcpProbeServer: { server: any; peerId: string } | null = null
/** Active UDP probe sockets: peerId → { socket, nonce, onData callback } */
const udpProbeSockets = new Map<string, { socket: any; nonce: string; resolved: boolean; onData: (buf: any) => void }>()
/** Forced mode per peer (set by server, null = auto) */
const forcedModes = new Map<string, 'force-direct' | 'force-relay'>()

// ─── Helpers ───

function sendMsg(msg: NegotiateMessage) {
    wsSend(JSON.stringify(msg))
}

function setAwgEndpoint(ifName: string, pubkey: string, endpoint: string) {
    return execSafe(`awg set ${ifName} peer ${pubkey} endpoint ${endpoint}`)
}

/** Apply mode switch — shared by verdict and force-mode handlers */
async function switchPeerMode(peerId: string, target: 'relay' | 'direct') {
    const state = getPeerStates().get(peerId)
    if (!state) return

    if (target === 'relay') {
        await setAwgEndpoint(state.ifName, state.pubkey, `127.0.0.1:${state.relayPort}`)
        setPeerMode(peerId, 'relay')
        console.log(`[negotiate] ${state.ifName} → relay (:${state.relayPort})`)
    } else {
        if (state.directEndpoint) {
            await setAwgEndpoint(state.ifName, state.pubkey, state.directEndpoint)
            console.log(`[negotiate] ${state.ifName} → direct (${state.directEndpoint})`)
        } else {
            console.log(`[negotiate] ${state.ifName} → direct (endpoint pending, next poll will fix)`)
        }
        setPeerMode(peerId, 'direct')
    }
}

// ─── Message Handler ───

export function handleNegotiateMessage(msg: NegotiateMessage) {
    switch (msg.type) {
        case 'probe-relay-serve':
            handleProbeRelayServe(msg.with)
            break
        case 'probe-relay-check':
            handleProbeRelayCheck(msg)
            break
        case 'probe-direct-start':
            handleProbeDirectStart(msg.with)
            break
        case 'probe-direct-go':
            handleProbeDirectGo(msg)
            break
        case 'probe-verdict':
            handleProbeVerdict(msg)
            break
        case 'negotiate-abort':
            handleNegotiateAbort(msg)
            break
        case 'force-mode':
            handleForceMode(msg)
            break
        default:
            break
    }
}

// ─── Direct → Relay: TCP Probe (Server Role) ───

async function handleProbeRelayServe(withPeerId: string) {
    freezePeer(withPeerId)

    const nonce = crypto.randomUUID()

    try {
        const server = Bun.serve({
            hostname: selfMeshIpv4,
            port: 0, // ephemeral
            fetch(req) {
                const url = new URL(req.url)
                if (req.method === 'POST' && url.pathname === '/probe') {
                    return req.json().then((body: any) => {
                        if (body.nonce === nonce && body.serverPubkey === selfPubkey && body.clientPubkey) {
                            return new Response('OK', { status: 200 })
                        }
                        return new Response('Invalid credentials', { status: 403 })
                    }).catch(() => new Response('Bad request', { status: 400 }))
                }
                return new Response('Not found', { status: 404 })
            },
        })

        tcpProbeServer = { server, peerId: withPeerId }
        const tcpPort = server.port!

        console.log(`[negotiate] TCP probe server on ${selfMeshIpv4}:${tcpPort}`)

        sendMsg({
            type: 'probe-relay-ready',
            with: withPeerId,
            meshIpv4: selfMeshIpv4,
            tcpPort,
            nonce,
        })
    } catch (err) {
        console.error(`[negotiate] TCP probe server bind error:`, err)
        sendMsg({
            type: 'probe-error',
            with: withPeerId,
            error: `TCP bind failed: ${err}`,
        })
        unfreezePeer(withPeerId)
    }
}

// ─── Direct → Relay: TCP Probe (Client Role) ───

async function handleProbeRelayCheck(msg: Extract<NegotiateMessage, { type: 'probe-relay-check' }>) {
    freezePeer(msg.with)

    try {
        const res = await fetch(`http://${msg.meshIpv4}:${msg.tcpPort}/probe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clientPubkey: msg.clientPubkey,
                serverPubkey: msg.serverPubkey,
                nonce: msg.nonce,
            }),
            signal: AbortSignal.timeout(3000),
        })

        const success = res.ok
        console.log(`[negotiate] TCP probe to ${msg.meshIpv4}:${msg.tcpPort}: ${success ? 'OK' : 'FAIL'}`)

        sendMsg({
            type: 'probe-relay-result',
            with: msg.with,
            success,
        })
    } catch (err) {
        console.log(`[negotiate] TCP probe to ${msg.meshIpv4}:${msg.tcpPort} failed: ${err}`)
        sendMsg({
            type: 'probe-relay-result',
            with: msg.with,
            success: false,
        })
    }
}

// ─── Relay → Direct: UDP Probe ───

async function handleProbeDirectStart(withPeerId: string) {
    freezePeer(withPeerId)

    const nonce = crypto.randomUUID()
    const entry = { socket: null as any, nonce, resolved: false, onData: (_buf: any) => {} }

    try {
        const socket = await Bun.udpSocket({
            port: 0,
            hostname: '0.0.0.0',
            socket: {
                data(_sock: any, buf: any, _port: any, _addr: any) {
                    entry.onData(buf)
                }
            }
        })

        entry.socket = socket
        udpProbeSockets.set(withPeerId, entry)

        console.log(`[negotiate] UDP probe socket on :${socket.port} for ${withPeerId}`)

        sendMsg({
            type: 'probe-direct-ready',
            with: withPeerId,
            udpPort: socket.port,
            nonce,
        })
    } catch (err) {
        console.error(`[negotiate] UDP probe socket bind error:`, err)
        sendMsg({
            type: 'probe-error',
            with: withPeerId,
            error: `UDP bind failed: ${err}`,
        })
        unfreezePeer(withPeerId)
    }
}

async function handleProbeDirectGo(msg: Extract<NegotiateMessage, { type: 'probe-direct-go' }>) {
    const peerId = msg.with
    const entry = udpProbeSockets.get(peerId)

    if (!entry) {
        console.log(`[negotiate] probe-direct-go but no active probe socket for ${peerId}`)
        return
    }

    const { socket, nonce: ownNonce } = entry
    const ownNonceBytes = new TextEncoder().encode(ownNonce)

    // Wire up nonce check via mutable callback (no socket recreation needed)
    entry.onData = (buf: any) => {
        const received = new TextDecoder().decode(new Uint8Array(buf))
        if (received === msg.peerNonce) {
            entry.resolved = true
        }
    }

    // Send own nonce to peer 3 times (100ms apart)
    for (let i = 0; i < 3; i++) {
        try {
            socket.send(ownNonceBytes, msg.peerUdpPort, msg.peerIpv4)
        } catch (err) {
            console.error(`[negotiate] UDP probe send to ${msg.peerIpv4}:${msg.peerUdpPort} failed:`, err)
        }
        if (i < 2) await new Promise(r => setTimeout(r, 100))
    }

    // Poll until resolved or timeout (3s)
    let success = false
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
        if (entry.resolved) {
            success = true
            break
        }
        await new Promise(r => setTimeout(r, 50))
    }

    closeUdpProbeSocket(peerId)

    console.log(`[negotiate] UDP probe to ${msg.peerIpv4}:${msg.peerUdpPort}: ${success ? 'OK' : 'FAIL'}`)

    sendMsg({
        type: 'probe-direct-result',
        with: peerId,
        success,
    })
}

// ─── Verdict ───

async function handleProbeVerdict(msg: Extract<NegotiateMessage, { type: 'probe-verdict' }>) {
    const peerId = msg.with

    closeTcpProbeServer(peerId)
    closeUdpProbeSocket(peerId)
    unfreezePeer(peerId)

    if (msg.action === 'switch-relay') {
        await switchPeerMode(peerId, 'relay')
    } else if (msg.action === 'switch-direct') {
        await switchPeerMode(peerId, 'direct')
    } else {
        const state = getPeerStates().get(peerId)
        console.log(`[negotiate] ${state?.ifName ?? peerId} → stay (${state?.mode})`)
    }
}

// ─── Abort ───

function handleNegotiateAbort(msg: Extract<NegotiateMessage, { type: 'negotiate-abort' }>) {
    const peerId = msg.with
    console.log(`[negotiate] abort for ${peerId}: ${msg.reason}`)

    closeTcpProbeServer(peerId)
    closeUdpProbeSocket(peerId)
    unfreezePeer(peerId)
}

// ─── Force Mode ───

async function handleForceMode(msg: Extract<NegotiateMessage, { type: 'force-mode' }>) {
    const peerId = msg.with

    // Clean up any mid-negotiation state
    closeTcpProbeServer(peerId)
    closeUdpProbeSocket(peerId)
    unfreezePeer(peerId)

    if (msg.mode === 'auto') {
        forcedModes.delete(peerId)
        console.log(`[negotiate] ${peerId} → auto mode (keep current)`)
        return
    }

    forcedModes.set(peerId, msg.mode)
    await switchPeerMode(peerId, msg.mode === 'force-relay' ? 'relay' : 'direct')
}

// ─── Cleanup ───

function closeTcpProbeServer(peerId?: string) {
    if (tcpProbeServer && (!peerId || tcpProbeServer.peerId === peerId)) {
        try { tcpProbeServer.server.stop() } catch {}
        tcpProbeServer = null
    }
}

function closeUdpProbeSocket(peerId: string) {
    const entry = udpProbeSockets.get(peerId)
    if (entry) {
        try { entry.socket.close() } catch {}
        udpProbeSockets.delete(peerId)
    }
}

/** Reset all negotiate state (called on WS disconnect) */
export function resetNegotiateState() {
    // Close all probe resources
    if (tcpProbeServer) {
        try { tcpProbeServer.server.stop() } catch {}
        tcpProbeServer = null
    }
    for (const [, entry] of udpProbeSockets) {
        try { entry.socket.close() } catch {}
    }
    udpProbeSockets.clear()
    clearAllFrozen()
    forcedModes.clear()
}
