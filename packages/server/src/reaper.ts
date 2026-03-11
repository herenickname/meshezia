import { getDb } from './db'
import { sendTextToPeer } from './relay'
import { abortPeerNegotiations, cleanupPeerHealth } from './negotiate'

const REAPER_INTERVAL_MS = 30_000

let reaperTimer: ReturnType<typeof setInterval> | null = null

export function startReaper() {
    reaperTimer = setInterval(reap, REAPER_INTERVAL_MS)
    console.log(`[reaper] running every ${REAPER_INTERVAL_MS / 1000}s`)
}

export function stopReaper() {
    if (reaperTimer) { clearInterval(reaperTimer); reaperTimer = null }
}

function reap() {
    const db = getDb()
    const now = Date.now()

    const expired = db.query(`
        SELECT id, network_id FROM peers
        WHERE ttl_seconds > 0 AND (? - last_seen) > (ttl_seconds * 1000)
    `).all(now) as Array<{ id: string; network_id: string }>

    if (expired.length === 0) return

    // Group by network for notifications
    const byNetwork = new Map<string, string[]>()
    for (const row of expired) {
        const list = byNetwork.get(row.network_id) ?? []
        list.push(row.id)
        byNetwork.set(row.network_id, list)
    }

    // Abort negotiations and clean up health state before deleting
    for (const row of expired) {
        abortPeerNegotiations(row.id, 'peer-removed')
        cleanupPeerHealth(row.id)
    }

    // Delete expired peers (CASCADE cleans up peer_ports)
    try {
        const del = db.prepare('DELETE FROM peers WHERE id = ?')
        db.transaction(() => {
            for (const row of expired) {
                del.run(row.id)
            }
        })()
    } catch (err) {
        console.error(`[reaper] failed to delete expired peers:`, err)
        return
    }

    for (const row of expired) {
        console.log(`[reaper] deleted expired peer ${row.id}`)
    }

    // Notify remaining peers in affected networks
    for (const [networkId, deletedIds] of byNetwork) {
        const remaining = db.query(
            'SELECT id FROM peers WHERE network_id = ?'
        ).all(networkId) as Array<{ id: string }>

        for (const deletedId of deletedIds) {
            const msg = JSON.stringify({ type: 'peer-removed', peerId: deletedId })
            for (const peer of remaining) {
                sendTextToPeer(peer.id, msg)
            }
        }
    }
}
