import { ApiClient } from './client'
import { ensureDataDir, getOrCreateKeypair, setRtTableBase, setUserspace, getTableForIf } from './awg'
import { reconcile, getIfNameForPeer, setPortRange, getPortForPeer, loadMappings } from './reconciler'
import { initPeerState, removePeerState, tick, getPeerStates, collectHealthReports } from './monitor'
import { ensureRelayProxy, removeRelayProxy, connectWs, stopWs, setOnPeerRemoved, setOnAgentUpdate, isWsAlive, sendWsText } from './relay-proxy'
import { setNegotiateSelfIp, setNegotiateSelfPubkey } from './negotiate'
import { startObserver } from './observer'
import { readFile, writeFile, chmod, rename, unlink } from 'fs/promises'
import { execSafe } from './exec'
// @ts-ignore — JSON import, bundled at compile time
import rootPkg from '../../../package.json'

const VERSION: string = rootPkg.version

const STATE_FILE = '/var/lib/meshezia/state.json'

// ─── Parse args ───

function getArg(name: string): string | undefined {
    const prefix = `--${name}=`
    const arg = process.argv.find(a => a.startsWith(prefix))
    return arg?.slice(prefix.length)
}

const serverUrl = getArg('server')
const token = getArg('token')
const networkId = getArg('network')
const nodeName = getArg('name')
const publicIp = getArg('ipv4')
const pollInterval = Number(getArg('poll') ?? 10) * 1000
const observePort = Number(getArg('observe-port') ?? 9100)
const rtTableBase = Number(getArg('rt-table') ?? 4200)
const portRange = getArg('port-range') ?? '51820-52819'
const ttl = Number(getArg('ttl') ?? 0)
const memo = getArg('memo') ?? ''
const userspace = process.argv.includes('--userspace')

if (!serverUrl || !token || !networkId || !nodeName) {
    console.error('Usage: meshezia-agent --server=URL --token=TOKEN --network=ID --name=NAME [--ipv4=PUBLIC_IP] [--poll=SECONDS] [--observe-port=PORT] [--rt-table=BASE] [--port-range=START-END] [--ttl=SECONDS] [--memo=TEXT] [--userspace]')
    process.exit(1)
}

const client = new ApiClient(serverUrl, token)

// ─── Precheck ───

async function precheck() {
    const errors: string[] = []

    if (process.getuid?.() !== 0) {
        errors.push('Must run as root (need access to network interfaces and routing)')
    }

    const checks: Array<{ cmd: string; name: string; pkg: string; condition?: boolean }> = [
        { cmd: 'awg', name: 'awg', pkg: 'amneziawg-tools' },
        { cmd: 'ip', name: 'ip', pkg: 'iproute2' },
        { cmd: 'sysctl', name: 'sysctl', pkg: 'procps' },
        { cmd: 'amneziawg-go', name: 'amneziawg-go', pkg: 'amneziawg-go', condition: userspace },
    ]

    for (const { cmd, name, pkg, condition } of checks) {
        if (condition === false) continue
        const out = await execSafe(`command -v ${cmd}`)
        if (!out) {
            errors.push(`'${name}' not found — install ${pkg}`)
        }
    }

    if (!userspace) {
        const mod = await execSafe('modinfo amneziawg 2>/dev/null')
        if (!mod) {
            errors.push("kernel module 'amneziawg' not found — install amneziawg-dkms or use --userspace")
        }
    }

    if (errors.length > 0) {
        console.error('[agent] precheck failed:')
        for (const e of errors) console.error(`  - ${e}`)
        process.exit(1)
    }
}

// ─── Boot ───

async function boot() {
    await precheck()
    setRtTableBase(rtTableBase)
    setUserspace(userspace)
    const [prStart, prEnd] = portRange.split('-').map(Number)
    setPortRange(prStart, prEnd)
    await ensureDataDir()
    await loadMappings()

    const { privateKey, pubkey } = await getOrCreateKeypair()
    setNegotiateSelfPubkey(pubkey)
    console.log(`[agent] pubkey: ${pubkey}`)

    const myIp = publicIp ?? await detectPublicIp()
    console.log(`[agent] public IP: ${myIp}`)

    let peerId = await loadPeerId()
    let selfIpv4 = ''
    if (!peerId) {
        const peer = await client.register({
            networkId: networkId!,
            name: nodeName!,
            publicIpv4: myIp,
            pubkey,
            ttlSeconds: ttl || undefined,
            memo: memo || undefined,
            agentVersion: VERSION
        })
        peerId = peer.id
        selfIpv4 = peer.meshIpv4
        await savePeerId(peerId!)
        console.log(`[agent] registered as ${peerId}, mesh IP: ${selfIpv4}`)
    } else {
        await client.updatePeer(peerId, { pubkey, publicIpv4: myIp, memo: memo || undefined, agentVersion: VERSION })
        console.log(`[agent] loaded peer ${peerId}`)
    }

    connectWs({ url: client.wsUrl, token: token!, selfPeerId: peerId! })

    setOnAgentUpdate((url) => {
        selfUpdate(url)
    })

    // Declared here so setOnPeerRemoved can reference it before poll is defined
    let triggerPoll: () => void

    setOnPeerRemoved((_peerId) => {
        console.log(`[agent] peer removed notification, triggering immediate poll`)
        triggerPoll()
    })

    let lastPortsJson = ''

    async function poll() {
        try {
            const config = await client.getConfig(peerId!)
            selfIpv4 = config.self.meshIpv4
            setNegotiateSelfIp(selfIpv4)
            const result = await reconcile(config, privateKey)

            // Report our listen ports to the server (only when changed)
            if (result.ports.length > 0) {
                const portsJson = JSON.stringify(result.ports)
                if (portsJson !== lastPortsJson) {
                    await client.reportPorts(peerId!, result.ports)
                    lastPortsJson = portsJson
                }
            }

            const activePeerIds = new Set<string>()
            let idx = 0
            for (const peer of config.peers) {
                if (!peer.pubkey) continue
                activePeerIds.add(peer.id)
                const ifName = getIfNameForPeer(peer.id)
                if (!ifName) continue

                const awgPort = getPortForPeer(peer.id) ?? config.self.listenPort
                const relayPort = await ensureRelayProxy({ peerId: peer.id, index: idx, awgListenPort: awgPort })
                initPeerState({ peerId: peer.id, ifName, pubkey: peer.pubkey, peerIpv4: peer.meshIpv4, endpoint: peer.endpoint, relayPort })
                idx++
            }

            for (const [pid] of getPeerStates()) {
                if (!activePeerIds.has(pid)) {
                    removePeerState(pid)
                    removeRelayProxy(pid)
                }
            }

        } catch (err) {
            console.error(`[agent] poll error:`, err)
        }
    }

    triggerPoll = () => poll()

    await poll()

    // Start observer HTTP API
    startObserver({
        port: observePort,
        selfPeerId: peerId!,
        selfIpv4,
        selfName: nodeName!,
        networkId: networkId!,
        memo,
        onMemoUpdate: async (newMemo: string) => {
            await client.updatePeer(peerId!, { memo: newMemo })
        }
    })

    setInterval(async () => {
        try { await poll() } catch (err) { console.error('[agent] poll error:', err) }
    }, pollInterval)

    // Monitor tick: rx-bytes tracking (1s)
    setInterval(async () => {
        try { await tick() } catch (err) { console.error('[monitor] tick error:', err) }
    }, 1000)

    // Health report emission (3s via WS)
    setInterval(async () => {
        try {
            if (!isWsAlive()) return
            const reports = await collectHealthReports(true)
            if (reports.length > 0) {
                sendWsText(JSON.stringify({
                    type: 'health-report',
                    reports,
                }))
            }
        } catch (err) {
            console.error('[agent] health report error:', err)
        }
    }, 3000)

    console.log(`[agent] v${VERSION} running (poll every ${pollInterval / 1000}s)`)
}

// ─── Helpers ───

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

async function detectPublicIp(): Promise<string> {
    const services = [
        'https://ipv4.ifconfig.me/ip',
        'https://api4.ipify.org',
        'https://ipv4.icanhazip.com',
        'https://2ip.ru',
    ]
    for (const url of services) {
        try {
            const ip = (await execSafe(`curl -4 -sf --max-time 5 ${url}`)).trim()
            if (IPV4_RE.test(ip)) return ip
        } catch {}
    }
    throw new Error('Cannot detect public IPv4. Use --ipv4= to specify manually.')
}

async function loadPeerId(): Promise<string | null> {
    try {
        const data = JSON.parse(await readFile(STATE_FILE, 'utf-8'))
        return data.peerId ?? null
    } catch {
        return null
    }
}

async function savePeerId(peerId: string) {
    await writeFile(STATE_FILE, JSON.stringify({ peerId }))
}

// ─── Self-update ───

async function selfUpdate(url: string) {
    const binPath = process.execPath
    const tmpPath = binPath + '.update'

    console.log(`[agent] self-update: downloading from ${url}`)
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)

        const data = await res.arrayBuffer()
        if (data.byteLength < 1024) throw new Error('Downloaded file too small')

        await Bun.write(tmpPath, data)
        await chmod(tmpPath, 0o755)
        await rename(tmpPath, binPath)

        console.log(`[agent] self-update complete (${(data.byteLength / 1024 / 1024).toFixed(1)} MB), exiting for restart`)
        process.exit(0)
    } catch (err) {
        console.error(`[agent] self-update failed:`, err)
        try { await unlink(tmpPath) } catch {}
    }
}

// ─── Graceful shutdown ───

function shutdown() {
    console.log('[agent] shutting down...')
    stopWs()
    process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// ─── Start ───
boot().catch(err => {
    console.error('[agent] fatal:', err)
    process.exit(1)
})
