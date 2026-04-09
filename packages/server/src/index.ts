import { resolve, join } from 'path'
import { initDb, getDb } from './db'
import { createApi } from './api'
import { wsHandler, type WsData, sendTextToPeer, isPeerConnected, setOnNegotiateMessage, setOnDisconnect, startHeartbeat, stopHeartbeat } from './relay'
import { startReaper, stopReaper } from './reaper'
import { initNegotiator, handleNegotiateMessage, abortPeerNegotiations, startStaleSweep } from './negotiate'

function getArg(name: string): string | undefined {
    const prefix = `--${name}=`
    const arg = process.argv.find(a => a.startsWith(prefix))
    return arg?.slice(prefix.length)
}

const args = {
    port: Number(process.env.PORT ?? getArg('port') ?? 3000),
    token: process.env.MESHEZIA_TOKEN ?? getArg('token') ?? '',
    dbPath: process.env.DB_PATH ?? getArg('db') ?? 'meshezia.db',
    staticDir: process.env.STATIC_DIR ?? getArg('static') ?? ''
}

if (!args.token) {
    console.error('MESHEZIA_TOKEN env or --token= required')
    process.exit(1)
}

initDb(args.dbPath)

const api = createApi(args.token)

// Resolve static dir once at startup for path traversal protection
const resolvedStaticDir = args.staticDir ? resolve(args.staticDir) : ''

// ─── Security headers ───

const SECURITY_HEADERS: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
}

function withSecurityHeaders(res: Response): Response {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
        res.headers.set(k, v)
    }
    return res
}

// ─── Rate limiting (per-IP, fixed window) ───

const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS) || 60_000
const RATE_MAX_REQUESTS = Number(process.env.RATE_MAX_REQUESTS) || 120

const rateMap = new Map<string, { count: number; resetAt: number }>()

// Cleanup stale entries periodically
const rateLimitCleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [ip, entry] of rateMap) {
        if (now > entry.resetAt) rateMap.delete(ip)
    }
}, RATE_WINDOW_MS)

function checkRateLimit(ip: string): Response | null {
    const now = Date.now()
    let entry = rateMap.get(ip)
    if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + RATE_WINDOW_MS }
        rateMap.set(ip, entry)
    }
    entry.count++
    if (entry.count > RATE_MAX_REQUESTS) {
        return new Response('Too Many Requests', {
            status: 429,
            headers: { 'Retry-After': '60' }
        })
    }
    return null
}

// ─── Server ───

const server = Bun.serve<WsData>({
    port: args.port,
    maxRequestBodySize: 1024 * 1024, // 1 MB

    async fetch(req, server) {
        const url = new URL(req.url)
        const ip = server.requestIP(req)?.address ?? 'unknown'

        // Rate limiting
        const rateLimited = checkRateLimit(ip)
        if (rateLimited) return withSecurityHeaders(rateLimited)

        // WebSocket upgrade: /ws?token=...&peer=...
        if (url.pathname === '/ws') {
            const token = url.searchParams.get('token')
            const peerId = url.searchParams.get('peer')

            if (!token || !peerId) {
                return withSecurityHeaders(new Response('Missing token or peer param', { status: 400 }))
            }

            // Accept admin token or network token for the peer's network
            if (token !== args.token) {
                const db = getDb()
                // Check token against all networks first (avoids timing side-channel on peer existence)
                const network = db.query('SELECT id FROM networks WHERE token = ?').get(token) as any
                if (!network) return withSecurityHeaders(new Response('Unauthorized', { status: 401 }))
                const peer = db.query('SELECT network_id FROM peers WHERE id = ? AND network_id = ?').get(peerId, network.id) as any
                if (!peer) return withSecurityHeaders(new Response('Peer not found', { status: 404 }))
            }

            const ok = server.upgrade(req, { data: { peerId, srcIdBytes: null } })
            if (ok) return undefined
            return withSecurityHeaders(new Response('Upgrade failed', { status: 500 }))
        }

        // REST API
        if (url.pathname.startsWith('/api/')) {
            return withSecurityHeaders(await api.fetch(req))
        }

        // Static files (frontend) — with path traversal protection
        if (resolvedStaticDir) {
            const reqPath = url.pathname === '/' ? '/index.html' : url.pathname
            const resolved = resolve(join(resolvedStaticDir, decodeURIComponent(reqPath)))
            if (!resolved.startsWith(resolvedStaticDir + '/')) {
                return withSecurityHeaders(new Response('Forbidden', { status: 403 }))
            }
            const file = Bun.file(resolved)
            if (await file.exists()) return withSecurityHeaders(new Response(file))
            // SPA fallback
            return withSecurityHeaders(new Response(Bun.file(join(resolvedStaticDir, 'index.html'))))
        }

        return withSecurityHeaders(await api.fetch(req))
    },

    websocket: {
        ...wsHandler,
        idleTimeout: 30, // seconds — fast detection of stuck connections (à la TCP_USER_TIMEOUT)
        sendPings: true  // Bun auto-pings; if no pong within idleTimeout → close
    }
})

// Wire up negotiate module
initNegotiator({ sendText: sendTextToPeer, isConnected: isPeerConnected })
setOnNegotiateMessage(handleNegotiateMessage)
setOnDisconnect((peerId) => {
    abortPeerNegotiations(peerId)
})
startStaleSweep()

startReaper()
startHeartbeat()

// ─── Graceful shutdown ───

function shutdown() {
    console.log('[meshezia-server] shutting down...')
    clearInterval(rateLimitCleanupTimer)
    stopHeartbeat()
    stopReaper()
    stopStaleSweep()
    server.stop()
    process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

console.log(`[meshezia-server] listening on :${server.port}`)
console.log(`[meshezia-server] db: ${args.dbPath}`)
