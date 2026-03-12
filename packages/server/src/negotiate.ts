import { getDb } from './db'
import type { HealthReport, NegotiateMessage } from '@meshezia/shared'

// ─── Dependencies (injected via init to avoid circular imports) ───

let sendText: (peerId: string, message: string) => boolean = () => false
let isConnected: (peerId: string) => boolean = () => false

export function initNegotiator(deps: {
    sendText: (peerId: string, message: string) => boolean
    isConnected: (peerId: string) => boolean
}) {
    sendText = deps.sendText
    isConnected = deps.isConnected
}

// ─── Types ───

type ForcedMode = 'force-direct' | 'force-relay'

interface PairHealth {
    streakAB: number
    streakBA: number
    lastDirectProbeAt: number
    directProbeBackoff: number
    /** Cached forced_mode from DB (null = auto) */
    forcedMode: ForcedMode | null
    /** Timestamp of first health-report from peer A */
    joinedAtA?: number
    /** Timestamp of first health-report from peer B */
    joinedAtB?: number
}

type NegotiationType = 'relay-probe' | 'direct-probe'

interface NegotiationState {
    type: NegotiationType
    pairKey: string
    peerA: string
    peerB: string
    startedAt: number
    timeoutId: ReturnType<typeof setTimeout> | null
    // Relay probe state
    serverNode?: string
    clientNode?: string
    // Direct probe state
    readyA?: { udpPort: number; nonce: string }
    readyB?: { udpPort: number; nonce: string }
    resultA?: boolean
    resultB?: boolean
}

interface PeerInfo {
    pubkey: string
    publicIp: string
    networkId: string
}

// ─── State ───

const pairHealthMap = new Map<string, PairHealth>()
const activeNegotiations = new Map<string, NegotiationState>()

/** Grace period: skip streak accumulation after first health-report */
const GRACE_PERIOD_MS = Number(process.env.GRACE_PERIOD_MS ?? 15_000)
/** Dead streak threshold: consecutive dead reports per side before triggering probe */
const STREAK_THRESHOLD = 3
/** Overall timeout for relay (TCP) probe: lock → verdict */
const RELAY_PROBE_TIMEOUT_MS = 15_000
/** Timeout waiting for both probe-direct-ready messages */
const DIRECT_READY_TIMEOUT_MS = 10_000
/** Initial direct probe backoff (ms) */
const DIRECT_PROBE_BACKOFF_INIT_MS = Number(process.env.DIRECT_PROBE_INTERVAL_MS ?? 30_000)
/** Max direct probe backoff (ms) */
const DIRECT_PROBE_BACKOFF_MAX_MS = 240_000
/** Stale negotiation sweep interval (ms) */
const STALE_SWEEP_INTERVAL_MS = 10_000
/** Abort negotiations older than this (ms) */
const STALE_NEGOTIATION_MS = 30_000

// ─── Helpers ───

function pairKey(a: string, b: string): string {
    return a < b ? `${a}:${b}` : `${b}:${a}`
}

function parsePairKey(key: string): [string, string] {
    const [a, b] = key.split(':')
    return [a, b]
}

function sendMsg(peerId: string, msg: NegotiateMessage | { type: 'negotiate-abort'; with: string; reason: string }) {
    return sendText(peerId, JSON.stringify(msg))
}

function getOrCreateHealth(key: string): PairHealth {
    let h = pairHealthMap.get(key)
    if (!h) {
        h = {
            streakAB: 0,
            streakBA: 0,
            lastDirectProbeAt: 0,
            directProbeBackoff: DIRECT_PROBE_BACKOFF_INIT_MS,
            forcedMode: null,
        }
        pairHealthMap.set(key, h)
    }
    return h
}

/** Single consolidated peer lookup (replaces 3 individual query functions) */
function lookupPeer(peerId: string): PeerInfo | null {
    const row = getDb().query(
        'SELECT pubkey, public_ip, network_id FROM peers WHERE id = ?'
    ).get(peerId) as any
    if (!row) return null
    return { pubkey: row.pubkey, publicIp: row.public_ip, networkId: row.network_id }
}

function isRelayEnabledForNetwork(networkId: string): boolean {
    const row = getDb().query('SELECT relay_enabled FROM networks WHERE id = ?').get(networkId) as any
    return row ? row.relay_enabled !== 0 : false
}

// ─── Health Report Handling ───

let _upsertStmt: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null
function getUpsertStmt() {
    if (!_upsertStmt) {
        _upsertStmt = getDb().prepare(
            `INSERT INTO peer_links (from_peer_id, to_peer_id, mode, direct_alive, relay_alive, probing_direct, rx_bytes, tx_bytes, last_handshake, endpoint, if_name, routing_table, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(from_peer_id, to_peer_id) DO UPDATE SET
               mode = excluded.mode, direct_alive = excluded.direct_alive,
               relay_alive = excluded.relay_alive, probing_direct = excluded.probing_direct,
               rx_bytes = excluded.rx_bytes, tx_bytes = excluded.tx_bytes,
               last_handshake = excluded.last_handshake, endpoint = excluded.endpoint,
               if_name = excluded.if_name, routing_table = excluded.routing_table,
               updated_at = excluded.updated_at`
        )
    }
    return _upsertStmt
}

export function handleHealthReport(fromPeerId: string, reports: HealthReport[]) {
    const now = Date.now()
    const db = getDb()
    const upsert = getUpsertStmt()

    try {
        db.transaction(() => {
            for (const report of reports) {
                upsert.run(
                    fromPeerId, report.peerId, report.mode,
                    report.rxAlive ? 1 : 0, report.relayAlive ? 1 : 0, report.probingDirect ? 1 : 0,
                    report.rxBytes, report.txBytes, report.lastHandshake, report.endpoint,
                    report.ifName ?? '', report.routingTable ?? 0, now
                )
            }
        })()
    } catch (err) {
        console.error(`[negotiate] health report DB upsert failed:`, err)
    }

    // Process streaks (in-memory, no DB)
    for (const report of reports) {
        const key = pairKey(fromPeerId, report.peerId)
        const health = getOrCreateHealth(key)
        const [peerA] = parsePairKey(key)
        const isFromA = fromPeerId === peerA

        // Record join time for grace period
        if (isFromA && health.joinedAtA === undefined) {
            health.joinedAtA = now
        } else if (!isFromA && health.joinedAtB === undefined) {
            health.joinedAtB = now
        }

        // Grace period: skip streak accumulation for first 15s
        const joinedAt = isFromA ? health.joinedAtA : health.joinedAtB
        if (joinedAt && now - joinedAt < GRACE_PERIOD_MS) continue

        // Streaks only meaningful when mode=direct (on relay, rx includes relay traffic)
        if (report.mode === 'relay') continue

        // Update streak for reporting side
        if (report.rxAlive) {
            if (isFromA) health.streakAB = 0
            else health.streakBA = 0
        } else {
            if (isFromA) health.streakAB++
            else health.streakBA++
        }

        // Check if both sides have enough dead streaks
        if (health.streakAB >= STREAK_THRESHOLD && health.streakBA >= STREAK_THRESHOLD) {
            if (shouldInitiateRelayProbe(fromPeerId, report.peerId, key, health)) {
                initiateRelayProbe(key, health)
            }
        }
    }
}

const VALID_FORCED_MODES = new Set<ForcedMode>(['force-direct', 'force-relay'])

function getForcedModeFromDb(peerA: string, peerB: string): ForcedMode | null {
    const row = getDb().query(
        `SELECT forced_mode FROM peer_links
         WHERE (from_peer_id = ? AND to_peer_id = ?) OR (from_peer_id = ? AND to_peer_id = ?)
         LIMIT 1`
    ).get(peerA, peerB, peerB, peerA) as any
    const val = row?.forced_mode
    return val && VALID_FORCED_MODES.has(val) ? val : null
}

function shouldInitiateRelayProbe(peerA: string, peerB: string, key: string, health: PairHealth): boolean {
    if (activeNegotiations.has(key)) return false
    // Check in-memory cache first, fall back to DB (covers server restart)
    const cached = health.forcedMode
    const forced = cached ?? getForcedModeFromDb(peerA, peerB)
    if (forced !== null) {
        if (cached !== forced) {
            health.forcedMode = forced // sync cache
            console.log(`[negotiate] pair ${key} — skipped: forced mode (${forced})`)
        }
        return false
    }
    // Dead peer guard: both must be WS-connected
    if (!isConnected(peerA) || !isConnected(peerB)) {
        console.log(`[negotiate] pair ${key} — skipped: dead peer guard`)
        return false
    }
    // Relay must be enabled for this network
    const peer = lookupPeer(peerA)
    if (!peer || !isRelayEnabledForNetwork(peer.networkId)) {
        console.log(`[negotiate] pair ${key} — skipped: relay disabled`)
        return false
    }
    return true
}

// ─── Direct → Relay: TCP Probe ───

function initiateRelayProbe(key: string, health: PairHealth) {
    const [peerA, peerB] = parsePairKey(key)

    // Role selection: higher streak = TCP server; if equal, peerA (first in key)
    const serverNode = health.streakAB >= health.streakBA ? peerA : peerB
    const clientNode = serverNode === peerA ? peerB : peerA

    console.log(`[negotiate] pair ${key} — streak threshold (AB=${health.streakAB}, BA=${health.streakBA}), relay probe`)

    const neg: NegotiationState = {
        type: 'relay-probe',
        pairKey: key,
        peerA,
        peerB,
        startedAt: Date.now(),
        timeoutId: null,
        serverNode,
        clientNode,
    }

    activeNegotiations.set(key, neg)

    // Overall timeout
    neg.timeoutId = setTimeout(() => {
        console.log(`[negotiate] pair ${key} — relay probe timeout`)
        abortNegotiation(key, 'timeout')
    }, RELAY_PROBE_TIMEOUT_MS)

    // Step 2: tell server node to start TCP server
    sendMsg(serverNode, { type: 'probe-relay-serve', with: clientNode })
}

function handleProbeRelayReady(fromPeerId: string, msg: Extract<NegotiateMessage, { type: 'probe-relay-ready' }>) {
    const key = pairKey(fromPeerId, msg.with)
    const neg = activeNegotiations.get(key)
    if (!neg || neg.type !== 'relay-probe') return
    if (fromPeerId !== neg.serverNode) return

    console.log(`[negotiate] pair ${key} — probe-relay-ready from ${fromPeerId} (port ${msg.tcpPort})`)

    // Look up pubkeys for auth (single query per peer)
    const clientInfo = lookupPeer(neg.clientNode!)
    const serverInfo = lookupPeer(neg.serverNode!)
    if (!clientInfo || !serverInfo) {
        console.log(`[negotiate] pair ${key} — missing peer info, aborting`)
        abortNegotiation(key, 'timeout')
        return
    }

    // Step 4: tell client node to connect
    sendMsg(neg.clientNode!, {
        type: 'probe-relay-check',
        with: neg.serverNode!,
        meshIpv4: msg.meshIpv4,
        tcpPort: msg.tcpPort,
        nonce: msg.nonce,
        clientPubkey: clientInfo.pubkey,
        serverPubkey: serverInfo.pubkey,
    })
}

function handleProbeRelayResult(fromPeerId: string, msg: Extract<NegotiateMessage, { type: 'probe-relay-result' }>) {
    const key = pairKey(fromPeerId, msg.with)
    const neg = activeNegotiations.get(key)
    if (!neg || neg.type !== 'relay-probe') return
    if (fromPeerId !== neg.clientNode) return

    const action = msg.success ? 'switch-relay' : 'stay'
    console.log(`[negotiate] pair ${key} — probe-relay-result: success=${msg.success}, verdict: ${action}`)

    sendMsg(neg.peerA, { type: 'probe-verdict', with: neg.peerB, action })
    sendMsg(neg.peerB, { type: 'probe-verdict', with: neg.peerA, action })

    finishNegotiation(key)

    const health = pairHealthMap.get(key)
    if (health) {
        health.streakAB = 0
        health.streakBA = 0
    }
}

// ─── Relay → Direct: UDP Probe ───

/** Check relay pairs for direct probe backoff expiry — single batched query */
export function checkDirectProbes() {
    const now = Date.now()
    const db = getDb()

    // Single JOIN: find all pairs where both sides report relay mode and not forced
    const relayPairs = db.query(
        `SELECT a.from_peer_id AS peerA, a.to_peer_id AS peerB
         FROM peer_links a
         JOIN peer_links b ON a.from_peer_id = b.to_peer_id AND a.to_peer_id = b.from_peer_id
         WHERE a.mode = 'relay' AND b.mode = 'relay'
           AND a.forced_mode IS NULL AND b.forced_mode IS NULL
           AND a.from_peer_id < a.to_peer_id`
    ).all() as Array<{ peerA: string; peerB: string }>

    for (const row of relayPairs) {
        const key = pairKey(row.peerA, row.peerB)
        const health = pairHealthMap.get(key)
        if (!health) continue
        if (activeNegotiations.has(key)) continue
        if (!isConnected(row.peerA) || !isConnected(row.peerB)) continue
        if (now - health.lastDirectProbeAt < health.directProbeBackoff) continue

        // Relay enabled?
        const peer = lookupPeer(row.peerA)
        if (!peer || !isRelayEnabledForNetwork(peer.networkId)) continue

        console.log(`[negotiate] pair ${key} — direct probe backoff expired (${health.directProbeBackoff}ms)`)
        initiateDirectProbe(key, health)
    }
}

function initiateDirectProbe(key: string, health: PairHealth) {
    const [peerA, peerB] = parsePairKey(key)

    health.lastDirectProbeAt = Date.now()

    const neg: NegotiationState = {
        type: 'direct-probe',
        pairKey: key,
        peerA,
        peerB,
        startedAt: Date.now(),
        timeoutId: null,
    }

    activeNegotiations.set(key, neg)

    neg.timeoutId = setTimeout(() => {
        console.log(`[negotiate] pair ${key} — direct probe ready timeout`)
        if (isConnected(peerA)) sendMsg(peerA, { type: 'probe-verdict', with: peerB, action: 'stay' })
        if (isConnected(peerB)) sendMsg(peerB, { type: 'probe-verdict', with: peerA, action: 'stay' })
        finishNegotiation(key)
        health.directProbeBackoff = Math.min(health.directProbeBackoff * 2, DIRECT_PROBE_BACKOFF_MAX_MS)
    }, DIRECT_READY_TIMEOUT_MS)

    sendMsg(peerA, { type: 'probe-direct-start', with: peerB })
    sendMsg(peerB, { type: 'probe-direct-start', with: peerA })
}

function handleProbeDirectReady(fromPeerId: string, msg: Extract<NegotiateMessage, { type: 'probe-direct-ready' }>) {
    const key = pairKey(fromPeerId, msg.with)
    const neg = activeNegotiations.get(key)
    if (!neg || neg.type !== 'direct-probe') return

    const [peerA] = parsePairKey(key)
    if (fromPeerId === peerA) {
        neg.readyA = { udpPort: msg.udpPort, nonce: msg.nonce }
    } else {
        neg.readyB = { udpPort: msg.udpPort, nonce: msg.nonce }
    }

    if (!neg.readyA || !neg.readyB) return

    if (neg.timeoutId) clearTimeout(neg.timeoutId)

    console.log(`[negotiate] pair ${key} — both direct-ready, sending go`)

    // Single lookup per peer
    const infoA = lookupPeer(neg.peerA)
    const infoB = lookupPeer(neg.peerB)
    if (!infoA || !infoB) {
        console.log(`[negotiate] pair ${key} — missing peer info, aborting`)
        abortNegotiation(key, 'timeout')
        return
    }

    sendMsg(neg.peerA, {
        type: 'probe-direct-go',
        with: neg.peerB,
        peerIpv4: infoB.publicIp,
        peerUdpPort: neg.readyB.udpPort,
        peerNonce: neg.readyB.nonce,
    })
    sendMsg(neg.peerB, {
        type: 'probe-direct-go',
        with: neg.peerA,
        peerIpv4: infoA.publicIp,
        peerUdpPort: neg.readyA.udpPort,
        peerNonce: neg.readyA.nonce,
    })

    neg.timeoutId = setTimeout(() => {
        console.log(`[negotiate] pair ${key} — direct probe result timeout`)
        const health = pairHealthMap.get(key)
        sendMsg(neg.peerA, { type: 'probe-verdict', with: neg.peerB, action: 'stay' })
        sendMsg(neg.peerB, { type: 'probe-verdict', with: neg.peerA, action: 'stay' })
        finishNegotiation(key)
        if (health) {
            health.directProbeBackoff = Math.min(health.directProbeBackoff * 2, DIRECT_PROBE_BACKOFF_MAX_MS)
        }
    }, 10_000)
}

function handleProbeDirectResult(fromPeerId: string, msg: Extract<NegotiateMessage, { type: 'probe-direct-result' }>) {
    const key = pairKey(fromPeerId, msg.with)
    const neg = activeNegotiations.get(key)
    if (!neg || neg.type !== 'direct-probe') return

    const [peerA] = parsePairKey(key)
    if (fromPeerId === peerA) neg.resultA = msg.success
    else neg.resultB = msg.success

    if (neg.resultA === undefined || neg.resultB === undefined) return

    const bothSuccess = neg.resultA && neg.resultB
    const action = bothSuccess ? 'switch-direct' : 'stay'
    const health = pairHealthMap.get(key)

    console.log(`[negotiate] pair ${key} — direct probe results: A=${neg.resultA}, B=${neg.resultB}, verdict: ${action}`)

    sendMsg(neg.peerA, { type: 'probe-verdict', with: neg.peerB, action })
    sendMsg(neg.peerB, { type: 'probe-verdict', with: neg.peerA, action })
    finishNegotiation(key)

    if (health) {
        health.directProbeBackoff = bothSuccess
            ? DIRECT_PROBE_BACKOFF_INIT_MS
            : Math.min(health.directProbeBackoff * 2, DIRECT_PROBE_BACKOFF_MAX_MS)
    }
}

// ─── Probe Error ───

function handleProbeError(fromPeerId: string, msg: Extract<NegotiateMessage, { type: 'probe-error' }>) {
    const key = pairKey(fromPeerId, msg.with)
    const neg = activeNegotiations.get(key)
    if (!neg) return

    console.log(`[negotiate] pair ${key} — probe-error from ${fromPeerId}: ${msg.error}`)

    const health = pairHealthMap.get(key)
    if (health && neg.type === 'direct-probe') {
        health.directProbeBackoff = Math.min(health.directProbeBackoff * 2, DIRECT_PROBE_BACKOFF_MAX_MS)
    }

    abortNegotiation(key, 'timeout')
}

// ─── Admin Force Mode ───

export function handleForceMode(peerA: string, peerB: string, mode: 'force-direct' | 'force-relay' | 'auto') {
    const key = pairKey(peerA, peerB)
    const db = getDb()

    // Abort any active negotiation for this pair
    const neg = activeNegotiations.get(key)
    if (neg) {
        sendMsg(neg.peerA, { type: 'negotiate-abort', with: neg.peerB, reason: 'admin-force' })
        sendMsg(neg.peerB, { type: 'negotiate-abort', with: neg.peerA, reason: 'admin-force' })
        finishNegotiation(key)
    }

    const health = getOrCreateHealth(key)

    if (mode === 'auto') {
        db.run(
            `UPDATE peer_links SET forced_mode = NULL
             WHERE (from_peer_id = ? AND to_peer_id = ?) OR (from_peer_id = ? AND to_peer_id = ?)`,
            [peerA, peerB, peerB, peerA]
        )
        health.forcedMode = null
        health.streakAB = 0
        health.streakBA = 0
        health.directProbeBackoff = DIRECT_PROBE_BACKOFF_INIT_MS
    } else {
        db.run(
            `UPDATE peer_links SET forced_mode = ?
             WHERE (from_peer_id = ? AND to_peer_id = ?) OR (from_peer_id = ? AND to_peer_id = ?)`,
            [mode, peerA, peerB, peerB, peerA]
        )
        health.forcedMode = mode
        health.streakAB = 0
        health.streakBA = 0
    }

    sendMsg(peerA, { type: 'force-mode', with: peerB, mode })
    sendMsg(peerB, { type: 'force-mode', with: peerA, mode })
}

// ─── Negotiation Lifecycle ───

function finishNegotiation(key: string) {
    const neg = activeNegotiations.get(key)
    if (!neg) return
    if (neg.timeoutId) clearTimeout(neg.timeoutId)
    activeNegotiations.delete(key)
}

function abortNegotiation(key: string, reason: 'admin-force' | 'timeout' | 'ws-reset' | 'peer-removed') {
    const neg = activeNegotiations.get(key)
    if (!neg) return

    if (isConnected(neg.peerA)) sendMsg(neg.peerA, { type: 'negotiate-abort', with: neg.peerB, reason })
    if (isConnected(neg.peerB)) sendMsg(neg.peerB, { type: 'negotiate-abort', with: neg.peerA, reason })

    finishNegotiation(key)
}

/** Abort all active negotiations involving a peer (WS disconnect or reaper) */
export function abortPeerNegotiations(peerId: string, reason: 'ws-reset' | 'peer-removed' = 'ws-reset') {
    for (const [key, neg] of activeNegotiations) {
        if (neg.peerA === peerId || neg.peerB === peerId) {
            const otherPeer = neg.peerA === peerId ? neg.peerB : neg.peerA
            if (isConnected(otherPeer)) {
                sendMsg(otherPeer, { type: 'negotiate-abort', with: peerId, reason })
            }
            finishNegotiation(key)
        }
    }
}

/** Remove all pair health data involving a peer (reaper cleanup) */
export function cleanupPeerHealth(peerId: string) {
    for (const key of pairHealthMap.keys()) {
        const [a, b] = parsePairKey(key)
        if (a === peerId || b === peerId) {
            pairHealthMap.delete(key)
        }
    }
}

// ─── Message Router ───

export function handleNegotiateMessage(fromPeerId: string, msg: NegotiateMessage) {
    switch (msg.type) {
        case 'health-report':
            handleHealthReport(fromPeerId, msg.reports)
            break
        case 'probe-relay-ready':
            handleProbeRelayReady(fromPeerId, msg)
            break
        case 'probe-relay-result':
            handleProbeRelayResult(fromPeerId, msg)
            break
        case 'probe-direct-ready':
            handleProbeDirectReady(fromPeerId, msg)
            break
        case 'probe-direct-result':
            handleProbeDirectResult(fromPeerId, msg)
            break
        case 'probe-error':
            handleProbeError(fromPeerId, msg)
            break
        default:
            break
    }
}

// ─── Stale Negotiation Sweep ───

let staleSweepTimer: ReturnType<typeof setInterval> | null = null

export function startStaleSweep() {
    staleSweepTimer = setInterval(() => {
        const now = Date.now()
        let aborted = 0
        for (const [key, neg] of activeNegotiations) {
            if (now - neg.startedAt > STALE_NEGOTIATION_MS) {
                abortNegotiation(key, 'timeout')
                aborted++
            }
        }
        if (aborted > 0) {
            console.log(`[negotiate] stale sweep: aborted ${aborted} negotiation(s) older than ${STALE_NEGOTIATION_MS / 1000}s`)
        }

        checkDirectProbes()
    }, STALE_SWEEP_INTERVAL_MS)
}

export function stopStaleSweep() {
    if (staleSweepTimer) clearInterval(staleSweepTimer)
}
