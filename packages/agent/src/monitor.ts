import { getTableForIf } from './awg'
import { drainRelayForwarded } from './relay-proxy'
import type { HealthReport } from '@meshezia/shared'
import { getAllPeerStats, type PeerStats } from './awg'

export interface PeerState {
    ifName: string
    pubkey: string
    peerIpv4: string
    directEndpoint: string
    relayPort: number
    mode: 'direct' | 'relay'
    rxAlive: boolean
    lastRxBytes: number
    /** Direct miss counter (consecutive ticks without rx increase) */
    directMissed: number
}

/** Consecutive misses before declaring rx dead (3s ≈ 1 health report interval) */
const MISS_THRESHOLD = 3

const peerStates = new Map<string, PeerState>()
/** Peers frozen during active negotiation — skip health reporting */
const frozenPeers = new Set<string>()
/** Track when each peer was frozen — auto-unfreeze after timeout */
const frozenAt = new Map<string, number>()
/** Max time a peer can stay frozen before auto-unfreeze (safety net for lost messages) */
const FROZEN_TIMEOUT_MS = 30_000

export interface InitPeerOpts {
    peerId: string
    ifName: string
    pubkey: string
    peerIpv4: string
    endpoint: string
    relayPort: number
}

export function initPeerState(opts: InitPeerOpts) {
    const { peerId, ifName, pubkey, peerIpv4, endpoint, relayPort } = opts
    const existing = peerStates.get(peerId)
    if (existing) {
        existing.directEndpoint = endpoint
        existing.peerIpv4 = peerIpv4
        existing.pubkey = pubkey
        existing.ifName = ifName
        existing.relayPort = relayPort
        return
    }
    peerStates.set(peerId, {
        ifName, pubkey, peerIpv4,
        directEndpoint: endpoint,
        relayPort,
        mode: 'direct',
        rxAlive: true,
        lastRxBytes: -1,
        directMissed: 0,
    })
}

export function removePeerState(peerId: string) {
    peerStates.delete(peerId)
    frozenPeers.delete(peerId)
    frozenAt.delete(peerId)
}

export function freezePeer(peerId: string) {
    frozenPeers.add(peerId)
    frozenAt.set(peerId, Date.now())
}

export function unfreezePeer(peerId: string) {
    frozenPeers.delete(peerId)
    frozenAt.delete(peerId)
}

export function clearAllFrozen() {
    frozenPeers.clear()
    frozenAt.clear()
}

export function isFrozen(peerId: string): boolean {
    return frozenPeers.has(peerId)
}

export function getPeerStates() {
    return peerStates
}

/** Set peer mode and reset rx tracking */
export function setPeerMode(peerId: string, mode: 'direct' | 'relay') {
    const state = peerStates.get(peerId)
    if (!state) return
    state.mode = mode
    state.lastRxBytes = -1
    state.directMissed = 0
    state.rxAlive = mode === 'direct' // assume alive on switch
}

// ─── Cached getAllPeerStats (avoids duplicate subprocess calls) ───

const STATS_CACHE_TTL_MS = 500
let cachedStats: Map<string, PeerStats> | null = null
let cachedStatsAt = 0

async function getCachedPeerStats(): Promise<Map<string, PeerStats>> {
    const now = Date.now()
    if (cachedStats && now - cachedStatsAt < STATS_CACHE_TTL_MS) return cachedStats
    cachedStats = await getAllPeerStats()
    cachedStatsAt = now
    return cachedStats
}

/**
 * Called every 1s: track rx bytes for rxAlive flag.
 * Simplified — no failover logic, just data collection.
 */
export async function tick() {
    // Auto-unfreeze peers stuck longer than FROZEN_TIMEOUT_MS (safety net)
    const now = Date.now()
    for (const [peerId, ts] of frozenAt) {
        if (now - ts > FROZEN_TIMEOUT_MS) {
            console.warn(`[monitor] auto-unfreezing stuck peer ${peerId} (frozen ${Math.round((now - ts) / 1000)}s)`)
            frozenPeers.delete(peerId)
            frozenAt.delete(peerId)
        }
    }

    const allStats = await getCachedPeerStats()
    const relayForwarded = drainRelayForwarded()

    for (const [peerId, state] of peerStates) {
        if (frozenPeers.has(peerId)) continue

        const rx = allStats.get(`${state.ifName}\t${state.pubkey}`)?.rxBytes ?? 0

        // Only track rxAlive when on direct mode
        // On relay, rx-bytes include relay traffic → not useful for direct path detection
        if (state.mode === 'direct') {
            const tainted = relayForwarded.has(peerId)
            if (!tainted && state.lastRxBytes >= 0 && rx > state.lastRxBytes) {
                state.directMissed = 0
                state.rxAlive = true
            } else if (state.lastRxBytes >= 0) {
                state.directMissed++
                if (state.directMissed >= MISS_THRESHOLD) {
                    state.rxAlive = false
                }
            }
            state.lastRxBytes = rx
        }
    }
}

/** Collect health reports for all non-frozen peers */
export async function collectHealthReports(wsAlive: boolean): Promise<HealthReport[]> {
    const allStats = await getCachedPeerStats()
    const reports: HealthReport[] = []

    for (const [peerId, state] of peerStates) {
        if (frozenPeers.has(peerId)) continue

        const stats = allStats.get(`${state.ifName}\t${state.pubkey}`)
        reports.push({
            peerId,
            mode: state.mode,
            rxAlive: state.rxAlive,
            relayAlive: wsAlive,
            probingDirect: false,
            rxBytes: stats?.rxBytes ?? 0,
            txBytes: stats?.txBytes ?? 0,
            lastHandshake: stats?.latestHandshake ?? 0,
            endpoint: stats?.endpoint ?? '',
            ifName: state.ifName,
            routingTable: getTableForIf(state.ifName),
        })
    }

    return reports
}
