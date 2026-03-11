import type { PeerConfig } from '@meshezia/shared'
import { ensureInterface, removeInterface, listInterfaces, ifIndex, DATA_DIR } from './awg'
import { getPeerStates, isFrozen } from './monitor'
import { readFile, writeFile } from 'fs/promises'

const MAPPINGS_FILE = `${DATA_DIR}/mappings.json`

const peerToIf = new Map<string, string>()
const peerToPort = new Map<string, number>()
let portRangeStart = 51820
let portRangeEnd = 52819
let loaded = false
let dirty = false

/** Load persisted peer→interface/port mappings from disk */
export async function loadMappings() {
    if (loaded) return
    loaded = true
    try {
        const data = JSON.parse(await readFile(MAPPINGS_FILE, 'utf-8'))
        for (const [peerId, m] of Object.entries(data as Record<string, { ifIndex: number; port: number }>)) {
            peerToIf.set(peerId, `mza${m.ifIndex}`)
            if (m.port) peerToPort.set(peerId, m.port)
        }
        console.log(`[reconcile] loaded ${peerToIf.size} cached mappings`)
    } catch {
        // No file yet — fresh start
    }
}

/** Save current mappings to disk (only if changed) */
async function saveMappings() {
    if (!dirty) return
    const data: Record<string, { ifIndex: number; port: number }> = {}
    for (const [peerId, ifName] of peerToIf.entries()) {
        data[peerId] = {
            ifIndex: ifIndex(ifName),
            port: peerToPort.get(peerId) ?? 0,
        }
    }
    await writeFile(MAPPINGS_FILE, JSON.stringify(data, null, 2))
    dirty = false
}

function getIfName(peerId: string): string {
    let name = peerToIf.get(peerId)
    if (!name) {
        const usedIndices = new Set(
            Array.from(peerToIf.values()).map(ifIndex)
        )
        let idx = 0
        while (usedIndices.has(idx)) idx++
        name = `mza${idx}`
        peerToIf.set(peerId, name)
        dirty = true
    }
    return name
}

function getPort(peerId: string): number {
    let port = peerToPort.get(peerId)
    if (!port) {
        const usedPorts = new Set(peerToPort.values())
        // Pick a random port from range that's not already used
        for (let i = 0; i < 1000; i++) {
            const candidate = portRangeStart + Math.floor(Math.random() * (portRangeEnd - portRangeStart + 1))
            if (!usedPorts.has(candidate)) {
                port = candidate
                break
            }
        }
        if (!port) throw new Error('No available ports in range')
        peerToPort.set(peerId, port)
        dirty = true
    }
    return port
}

export function setPortRange(start: number, end: number) {
    portRangeStart = start
    portRangeEnd = end
}

export function getIfNameForPeer(peerId: string): string | undefined {
    return peerToIf.get(peerId)
}

export function getPortForPeer(peerId: string): number | undefined {
    return peerToPort.get(peerId)
}

export interface ReconcileResult {
    /** Ports this agent listens on: [{peerId, port}] — report to server */
    ports: Array<{ peerId: string; port: number }>
}

/**
 * Reconcile: diff desired config vs actual interfaces, apply changes.
 * Returns assigned listen ports for reporting to server.
 */
export async function reconcile(config: PeerConfig, privateKey: string): Promise<ReconcileResult> {
    const existingInterfaces = await listInterfaces()
    const desiredPeerIds = new Set(config.peers.map(p => p.id))
    const ports: Array<{ peerId: string; port: number }> = []

    for (const peer of config.peers) {
        if (!peer.pubkey) continue

        const ifName = getIfName(peer.id)
        const isNew = !existingInterfaces.includes(ifName)
        // Use server-known port if we previously reported one, otherwise assign new
        const listenPort = peer.listenPort > 0 ? peer.listenPort : getPort(peer.id)
        // Remember the port locally (mark dirty if changed)
        if (peerToPort.get(peer.id) !== listenPort) {
            peerToPort.set(peer.id, listenPort)
            dirty = true
        }

        // Skip endpoint if peer is on relay or frozen (mid-negotiation) — unless new interface
        const peerState = getPeerStates().get(peer.id)
        const skipEndpoint = !isNew && (peerState?.mode === 'relay' || isFrozen(peer.id))

        try {
            await ensureInterface({
                ifName,
                selfIpv4: config.self.meshIpv4,
                listenPort,
                privateKey,
                awg: config.network,
                peer,
                existingInterfaces,
                skipEndpoint,
            })
        } catch (err) {
            console.error(`[reconcile] ${ifName} setup failed, will retry:`, (err as Error).message)
            continue
        }

        ports.push({ peerId: peer.id, port: listenPort })
    }

    // Remove interfaces for peers no longer in config
    for (const [peerId, ifName] of peerToIf.entries()) {
        if (!desiredPeerIds.has(peerId)) {
            await removeInterface(ifName)
            peerToIf.delete(peerId)
            peerToPort.delete(peerId)
            dirty = true
            console.log(`[reconcile] removed ${ifName} (peer ${peerId} gone)`)
        }
    }

    await saveMappings()
    return { ports }
}
