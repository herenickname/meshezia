import { Hono } from 'hono'
import { getDb } from './db'
import { allocateIp } from './subnet'
import type { Network, Peer, PeerConfig, PeerEndpoint } from '@meshezia/shared'
import { handleForceMode } from './negotiate'
import { sendTextToPeer, isPeerConnected } from './relay'

// ─── Validation helpers ───

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PUBKEY_RE = /^[A-Za-z0-9+/]{43}=$/

function isString(v: unknown): v is string {
    return typeof v === 'string'
}

function isValidUUID(v: unknown): v is string {
    return isString(v) && UUID_RE.test(v)
}

function isValidIPv4(v: unknown): v is string {
    if (!isString(v)) return false
    const parts = v.split('.')
    if (parts.length !== 4) return false
    return parts.every(p => {
        const n = Number(p)
        return Number.isInteger(n) && n >= 0 && n <= 255 && p === String(n)
    })
}

function isValidCIDR(v: unknown): v is string {
    if (!isString(v)) return false
    const slash = v.indexOf('/')
    if (slash === -1) return false
    const ip = v.slice(0, slash)
    const prefix = Number(v.slice(slash + 1))
    if (!Number.isInteger(prefix) || prefix < 8 || prefix > 30) return false
    return isValidIPv4(ip)
}

function isValidName(v: unknown): v is string {
    return isString(v) && v.length >= 1 && v.length <= 255 && !/[\x00-\x1f\x7f]/.test(v)
}

function isValidPort(v: unknown): v is number {
    return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535
}

function isValidPubkey(v: unknown): v is string {
    return isString(v) && PUBKEY_RE.test(v)
}

function isValidMemo(v: unknown): v is string {
    return isString(v) && v.length <= 1024
}

function isValidTTL(v: unknown): v is number {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 31536000
}

// ─── Helpers ───

function generateToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

function randInt(min: number, max: number): number {
    return min + Math.floor(Math.random() * (max - min + 1))
}

/** Generate random AWG obfuscation params per amneziawg spec */
function generateAwgParams() {
    const jc = randInt(3, 8)
    const jmin = randInt(50, 200)
    const jmax = jmin + randInt(50, 800)
    const s1 = randInt(15, 150)
    const s2 = randInt(15, 150)

    // H1-H4: random uint32, must differ from standard WG types (1-4) and be unique
    const reserved = new Set([1, 2, 3, 4])
    const headers: number[] = []
    while (headers.length < 4) {
        const v = crypto.getRandomValues(new Uint32Array(1))[0]
        if (!reserved.has(v) && !headers.includes(v)) {
            headers.push(v)
        }
    }
    return { jc, jmin, jmax, s1, s2, h1: headers[0], h2: headers[1], h3: headers[2], h4: headers[3] }
}

// ─── Formatters ───

/** Map SQLite snake_case row to camelCase API response (token excluded for safety) */
function formatNetwork(row: any) {
    return {
        id: row.id,
        name: row.name,
        subnet: row.subnet,
        listenPort: row.listen_port,
        relayEnabled: row.relay_enabled !== 0,
        jc: row.jc, jmin: row.jmin, jmax: row.jmax,
        s1: row.s1, s2: row.s2,
        h1: row.h1, h2: row.h2, h3: row.h3, h4: row.h4
    }
}

/** Format network with token — only returned on creation */
function formatNetworkWithToken(row: any) {
    return { ...formatNetwork(row), token: row.token }
}

function formatLink(row: any) {
    return {
        fromPeerId: row.from_peer_id,
        fromName: row.from_name,
        toPeerId: row.to_peer_id,
        toName: row.to_name,
        mode: row.mode,
        directAlive: !!row.direct_alive,
        relayAlive: !!row.relay_alive,
        probingDirect: !!row.probing_direct,
        rxBytes: row.rx_bytes,
        txBytes: row.tx_bytes,
        lastHandshake: row.last_handshake,
        endpoint: row.endpoint,
        ifName: row.if_name ?? '',
        routingTable: row.routing_table ?? 0,
        updatedAt: row.updated_at
    }
}

function formatPeer(row: any) {
    return {
        id: row.id,
        networkId: row.network_id,
        name: row.name,
        publicIpv4: row.public_ip,
        pubkey: row.pubkey,
        meshIpv4: row.ipv4,
        lastSeen: row.last_seen,
        isRelayEligible: !!row.is_relay_eligible,
        ttlSeconds: row.ttl_seconds,
        memo: row.memo ?? '',
        agentVersion: row.agent_version ?? ''
    }
}

export function createApi(adminToken: string) {
    const api = new Hono()

    // ─── Auth helpers ───

    function getBearer(c: any): string | null {
        const auth = c.req.header('Authorization')
        if (!auth?.startsWith('Bearer ')) return null
        return auth.slice(7)
    }

    function isAdmin(c: any): boolean {
        return getBearer(c) === adminToken
    }

    /** Check if bearer token matches a specific network */
    function isNetworkToken(c: any, networkId: string): boolean {
        const token = getBearer(c)
        if (!token) return false
        const row = getDb().query('SELECT id FROM networks WHERE id = ? AND token = ?').get(networkId, token) as any
        return !!row
    }

    /** Find network ID by its token */
    function networkIdByToken(c: any): string | null {
        const token = getBearer(c)
        if (!token) return null
        const row = getDb().query('SELECT id FROM networks WHERE token = ?').get(token) as any
        return row?.id ?? null
    }

    /** Require admin token */
    function requireAdmin(c: any): Response | null {
        if (!isAdmin(c)) return c.json({ error: 'Unauthorized' }, 401)
        return null
    }

    /** Require admin OR matching network token */
    function requireAdminOrNetwork(c: any, networkId: string): Response | null {
        if (isAdmin(c) || isNetworkToken(c, networkId)) return null
        return c.json({ error: 'Unauthorized' }, 401)
    }

    // ─── Networks (admin only) ───

    api.post('/api/networks', async (c) => {
        const deny = requireAdmin(c)
        if (deny) return deny

        let body: any
        try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
        if (!isValidName(body.name)) return c.json({ error: 'Invalid name (1-255 chars, no control chars)' }, 400)
        if (!isValidCIDR(body.subnet)) return c.json({ error: 'Invalid subnet (CIDR /8-/30)' }, 400)
        if (body.listenPort !== undefined && !isValidPort(body.listenPort))
            return c.json({ error: 'Invalid listenPort (1-65535)' }, 400)

        const id = crypto.randomUUID()
        const token = generateToken()
        const defaults = generateAwgParams()
        const db = getDb()
        try {
            db.run(
                `INSERT INTO networks (id, name, token, subnet, listen_port, jc, jmin, jmax, s1, s2, h1, h2, h3, h4)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [id, body.name, token, body.subnet, body.listenPort ?? 51820,
                 body.jc ?? defaults.jc, body.jmin ?? defaults.jmin, body.jmax ?? defaults.jmax,
                 body.s1 ?? defaults.s1, body.s2 ?? defaults.s2,
                 body.h1 ?? defaults.h1, body.h2 ?? defaults.h2, body.h3 ?? defaults.h3, body.h4 ?? defaults.h4]
            )
        } catch (err: any) {
            if (err?.message?.includes('UNIQUE')) return c.json({ error: 'Network name already exists' }, 409)
            console.error('[api] network INSERT failed:', err)
            return c.json({ error: 'Database error' }, 500)
        }
        const network = db.query('SELECT * FROM networks WHERE id = ?').get(id)
        return c.json(formatNetworkWithToken(network), 201)
    })

    api.get('/api/networks', (c) => {
        const deny = requireAdmin(c)
        if (deny) return deny
        return c.json(getDb().query('SELECT * FROM networks').all().map(formatNetwork))
    })

    api.get('/api/networks/:id', (c) => {
        const deny = requireAdmin(c)
        if (deny) return deny
        const row = getDb().query('SELECT * FROM networks WHERE id = ?').get(c.req.param('id'))
        if (!row) return c.json({ error: 'Not found' }, 404)
        return c.json(formatNetwork(row))
    })

    /** Dedicated endpoint to retrieve network token (admin only) */
    api.get('/api/networks/:id/token', (c) => {
        const deny = requireAdmin(c)
        if (deny) return deny
        const row = getDb().query('SELECT token FROM networks WHERE id = ?').get(c.req.param('id')) as any
        if (!row) return c.json({ error: 'Not found' }, 404)
        return c.json({ token: row.token })
    })

    api.delete('/api/networks/:id', (c) => {
        const deny = requireAdmin(c)
        if (deny) return deny
        getDb().run('DELETE FROM networks WHERE id = ?', [c.req.param('id')])
        return c.json({ ok: true })
    })

    api.patch('/api/networks/:id', async (c) => {
        const deny = requireAdmin(c)
        if (deny) return deny

        let body: any
        try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
        const db = getDb()
        const id = c.req.param('id')

        if (body.name !== undefined) {
            const name = String(body.name).trim()
            if (!name || name.length > 100) return c.json({ error: 'Name must be 1-100 chars' }, 400)
            db.run('UPDATE networks SET name = ? WHERE id = ?', [name, id])
        }

        if (body.relayEnabled !== undefined) {
            db.run('UPDATE networks SET relay_enabled = ? WHERE id = ?', [body.relayEnabled ? 1 : 0, id])
        }

        const updated = db.query('SELECT * FROM networks WHERE id = ?').get(id)
        if (!updated) return c.json({ error: 'Not found' }, 404)
        return c.json(formatNetwork(updated))
    })

    // ─── Peers (admin or network token) ───

    api.post('/api/peers', async (c) => {
        let body: any
        try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

        if (!isValidUUID(body.networkId)) return c.json({ error: 'Invalid networkId' }, 400)
        if (!isValidName(body.name)) return c.json({ error: 'Invalid name (1-255 chars)' }, 400)
        if (body.publicIpv4 !== undefined && body.publicIpv4 !== '' && !isValidIPv4(body.publicIpv4))
            return c.json({ error: 'Invalid publicIpv4' }, 400)
        if (body.pubkey !== undefined && body.pubkey !== '' && !isValidPubkey(body.pubkey))
            return c.json({ error: 'Invalid pubkey (base64, 44 chars)' }, 400)
        if (body.ttlSeconds !== undefined && !isValidTTL(body.ttlSeconds))
            return c.json({ error: 'Invalid ttlSeconds (0-31536000)' }, 400)
        if (body.memo !== undefined && !isValidMemo(body.memo))
            return c.json({ error: 'Invalid memo (max 1024 chars)' }, 400)

        // Auth check before DB queries to avoid timing side-channel
        const deny = requireAdminOrNetwork(c, body.networkId)
        if (deny) return deny

        const db = getDb()

        const network = db.query('SELECT * FROM networks WHERE id = ?').get(body.networkId) as any
        if (!network) return c.json({ error: 'Network not found' }, 404)

        const id = crypto.randomUUID()
        let ipv4: string
        try {
            ipv4 = allocateIp(body.networkId, network.subnet)
        } catch {
            return c.json({ error: 'No free IPs available' }, 409)
        }

        try {
            db.run(
                `INSERT INTO peers (id, network_id, name, public_ip, pubkey, ipv4, last_seen, ttl_seconds, memo, agent_version)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [id, body.networkId, body.name, body.publicIpv4 ?? '', body.pubkey ?? '', ipv4, Date.now(), body.ttlSeconds ?? 0, body.memo ?? '', body.agentVersion ?? '']
            )
        } catch (err: any) {
            if (err?.message?.includes('UNIQUE')) return c.json({ error: 'Peer name already exists in this network' }, 409)
            console.error('[api] peer INSERT failed:', err)
            return c.json({ error: 'Database error' }, 500)
        }

        const peer = db.query('SELECT * FROM peers WHERE id = ?').get(id)
        return c.json(formatPeer(peer), 201)
    })

    api.get('/api/peers', (c) => {
        const networkId = c.req.query('network_id')
        if (networkId) {
            const deny = requireAdminOrNetwork(c, networkId)
            if (deny) return deny
            return c.json(getDb().query('SELECT * FROM peers WHERE network_id = ?').all(networkId).map(formatPeer))
        }
        // List all peers — admin only
        const deny = requireAdmin(c)
        if (deny) return deny
        return c.json(getDb().query('SELECT * FROM peers').all().map(formatPeer))
    })

    api.delete('/api/peers/:id', (c) => {
        const db = getDb()
        const peer = db.query('SELECT * FROM peers WHERE id = ?').get(c.req.param('id')) as any
        if (!peer) return c.json({ error: 'Not found' }, 404)

        const deny = requireAdminOrNetwork(c, peer.network_id)
        if (deny) return deny

        db.run('DELETE FROM peers WHERE id = ?', [c.req.param('id')])
        return c.json({ ok: true })
    })

    // ─── Peer Ports (agent reports its listen ports) ───

    api.put('/api/peers/:id/ports', async (c) => {
        const db = getDb()
        const peerId = c.req.param('id')

        const peer = db.query('SELECT * FROM peers WHERE id = ?').get(peerId) as any
        if (!peer) return c.json({ error: 'Peer not found' }, 404)

        const deny = requireAdminOrNetwork(c, peer.network_id)
        if (deny) return deny

        let ports: unknown
        try { ports = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

        if (!Array.isArray(ports) || ports.length > 100)
            return c.json({ error: 'Invalid ports (array, max 100 entries)' }, 400)

        for (const entry of ports) {
            if (!entry || typeof entry !== 'object') return c.json({ error: 'Invalid port entry' }, 400)
            if (!isValidUUID((entry as any).peerId)) return c.json({ error: 'Invalid peerId in port entry' }, 400)
            if (!isValidPort((entry as any).port)) return c.json({ error: 'Invalid port number (1-65535)' }, 400)
        }

        const validPorts = ports as Array<{ peerId: string; port: number }>

        const upsert = db.prepare(
            `INSERT INTO peer_ports (from_peer_id, to_peer_id, port)
             VALUES (?, ?, ?)
             ON CONFLICT(from_peer_id, to_peer_id) DO UPDATE SET port = excluded.port`
        )

        try {
            const tx = db.transaction(() => {
                for (const entry of validPorts) {
                    upsert.run(peerId, entry.peerId, entry.port)
                }
            })
            tx()
        } catch (err) {
            console.error('[api] peer_ports upsert failed:', err)
            return c.json({ error: 'Database error' }, 500)
        }

        return c.json({ ok: true })
    })

    // ─── Peer Config (agent polls this) ───

    api.get('/api/peers/:id/config', (c) => {
        const db = getDb()
        const peerId = c.req.param('id')

        const peer = db.query('SELECT * FROM peers WHERE id = ?').get(peerId) as any
        if (!peer) return c.json({ error: 'Peer not found' }, 404)

        const deny = requireAdminOrNetwork(c, peer.network_id)
        if (deny) return deny

        // Update last_seen
        db.run('UPDATE peers SET last_seen = ? WHERE id = ?', [Date.now(), peerId])

        const network = db.query('SELECT * FROM networks WHERE id = ?').get(peer.network_id) as any

        const otherPeers = db.query(
            'SELECT * FROM peers WHERE network_id = ? AND id != ? ORDER BY id'
        ).all(peer.network_id, peerId) as any[]

        // Load port assignments:
        // - myPorts: ports I listen on (from_peer_id = me)
        // - remotePorts: ports remote peers listen on for me (to_peer_id = me)
        const myPorts = new Map<string, number>()
        const remotePorts = new Map<string, number>()

        for (const row of db.query(
            'SELECT to_peer_id, port FROM peer_ports WHERE from_peer_id = ?'
        ).all(peerId) as any[]) {
            myPorts.set(row.to_peer_id, row.port)
        }

        for (const row of db.query(
            'SELECT from_peer_id, port FROM peer_ports WHERE to_peer_id = ?'
        ).all(peerId) as any[]) {
            remotePorts.set(row.from_peer_id, row.port)
        }

        const config: PeerConfig = {
            self: {
                id: peer.id,
                meshIpv4: peer.ipv4,
                listenPort: network.listen_port,
                memo: peer.memo ?? ''
            },
            relayEnabled: network.relay_enabled !== 0,
            network: {
                jc: network.jc, jmin: network.jmin, jmax: network.jmax,
                s1: network.s1, s2: network.s2,
                h1: network.h1, h2: network.h2, h3: network.h3, h4: network.h4
            },
            peers: otherPeers.map((p: any): PeerEndpoint => {
                const remotePort = remotePorts.get(p.id)
                return {
                    id: p.id,
                    name: p.name,
                    pubkey: p.pubkey,
                    meshIpv4: p.ipv4,
                    endpoint: remotePort ? `${p.public_ip}:${remotePort}` : '',
                    listenPort: myPorts.get(p.id) ?? 0
                }
            })
        }

        return c.json(config)
    })

    // ─── Links (admin: view all connection states for a network) ───

    api.get('/api/links', (c) => {
        const networkId = c.req.query('network_id')
        if (!networkId) return c.json({ error: 'network_id required' }, 400)

        const deny = requireAdminOrNetwork(c, networkId)
        if (deny) return deny

        const rows = getDb().query(
            `SELECT pl.*, p1.name as from_name, p2.name as to_name
             FROM peer_links pl
             JOIN peers p1 ON pl.from_peer_id = p1.id
             JOIN peers p2 ON pl.to_peer_id = p2.id
             WHERE p1.network_id = ?`
        ).all(networkId) as any[]

        return c.json(rows.map(formatLink))
    })

    // ─── Force mode (admin overrides pair mode via negotiate) ───

    api.post('/api/links/force-mode', async (c) => {
        const deny = requireAdmin(c)
        if (deny) return deny

        let body: any
        try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
        const { peerA, peerB, mode } = body as { peerA: string; peerB: string; mode: string }

        if (!isValidUUID(peerA) || !isValidUUID(peerB))
            return c.json({ error: 'Invalid peer ID format' }, 400)
        if (!['force-direct', 'force-relay', 'auto'].includes(mode))
            return c.json({ error: 'mode must be force-direct, force-relay, or auto' }, 400)

        const db = getDb()
        const peerARow = db.query('SELECT network_id FROM peers WHERE id = ?').get(peerA) as any
        const peerBRow = db.query('SELECT network_id FROM peers WHERE id = ?').get(peerB) as any
        if (!peerARow || !peerBRow) return c.json({ error: 'Peer not found' }, 404)
        if (peerARow.network_id !== peerBRow.network_id)
            return c.json({ error: 'Peers must belong to the same network' }, 400)

        handleForceMode(peerA, peerB, mode as 'force-direct' | 'force-relay' | 'auto')
        return c.json({ ok: true })
    })

    // ─── Peer update (pubkey, public_ip) ───

    api.patch('/api/peers/:id', async (c) => {
        let body: any
        try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
        const db = getDb()
        const id = c.req.param('id')

        const peer = db.query('SELECT * FROM peers WHERE id = ?').get(id) as any
        if (!peer) return c.json({ error: 'Not found' }, 404)

        const deny = requireAdminOrNetwork(c, peer.network_id)
        if (deny) return deny

        if (body.pubkey !== undefined) {
            if (body.pubkey !== '' && !isValidPubkey(body.pubkey))
                return c.json({ error: 'Invalid pubkey (base64, 44 chars)' }, 400)
            db.run('UPDATE peers SET pubkey = ? WHERE id = ?', [body.pubkey, id])
        }
        if (body.publicIpv4 !== undefined) {
            if (body.publicIpv4 !== '' && !isValidIPv4(body.publicIpv4))
                return c.json({ error: 'Invalid publicIpv4' }, 400)
            db.run('UPDATE peers SET public_ip = ? WHERE id = ?', [body.publicIpv4, id])
        }
        if (body.ttlSeconds !== undefined) {
            if (!isValidTTL(body.ttlSeconds))
                return c.json({ error: 'Invalid ttlSeconds (0-31536000)' }, 400)
            db.run('UPDATE peers SET ttl_seconds = ? WHERE id = ?', [body.ttlSeconds, id])
        }
        if (body.memo !== undefined) {
            if (!isValidMemo(body.memo))
                return c.json({ error: 'Invalid memo (max 1024 chars)' }, 400)
            db.run('UPDATE peers SET memo = ? WHERE id = ?', [body.memo, id])
        }
        if (body.agentVersion !== undefined && typeof body.agentVersion === 'string' && body.agentVersion.length <= 64) {
            db.run('UPDATE peers SET agent_version = ? WHERE id = ?', [body.agentVersion, id])
        }

        const updated = db.query('SELECT * FROM peers WHERE id = ?').get(id)
        return c.json(formatPeer(updated))
    })

    // ─── Agent self-update push (admin triggers binary update on peer) ───

    api.post('/api/peers/:id/update', async (c) => {
        const deny = requireAdmin(c)
        if (deny) return deny

        let body: any
        try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

        if (!body.url || typeof body.url !== 'string')
            return c.json({ error: 'url required' }, 400)
        try { new URL(body.url) } catch { return c.json({ error: 'Invalid URL' }, 400) }

        const peerId = c.req.param('id')
        const db = getDb()
        const peer = db.query('SELECT id FROM peers WHERE id = ?').get(peerId) as any
        if (!peer) return c.json({ error: 'Peer not found' }, 404)

        if (!isPeerConnected(peerId))
            return c.json({ error: 'Peer not connected via WebSocket' }, 409)

        sendTextToPeer(peerId, JSON.stringify({ type: 'agent-update', url: body.url }))
        return c.json({ ok: true })
    })

    return api
}
