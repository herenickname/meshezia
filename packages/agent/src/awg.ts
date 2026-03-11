import { exec, execSafe } from './exec'
import type { AwgParams, PeerEndpoint } from '@meshezia/shared'
import { readFile, writeFile, mkdir } from 'fs/promises'

export const DATA_DIR = '/var/lib/meshezia'
const KEY_FILE = `${DATA_DIR}/privatekey`
const PUBKEY_FILE = `${DATA_DIR}/pubkey`

/** fwmark & routing table base — mza0=base+0, mza1=base+1, etc. */
let RT_TABLE_BASE = 4200

/** Use amneziawg-go userspace instead of kernel module */
let USERSPACE = false

/** AWG persistent keepalive interval (seconds) */
export const PERSISTENT_KEEPALIVE = 3

export function setRtTableBase(base: number) {
    RT_TABLE_BASE = base
}

export function setUserspace(enabled: boolean) {
    USERSPACE = enabled
}

export async function ensureDataDir() {
    await mkdir(DATA_DIR, { recursive: true })
}

/** Generate AWG keypair or load existing */
export async function getOrCreateKeypair(): Promise<{ privateKey: string; pubkey: string }> {
    try {
        const privateKey = (await readFile(KEY_FILE, 'utf-8')).trim()
        const pubkey = (await readFile(PUBKEY_FILE, 'utf-8')).trim()
        return { privateKey, pubkey }
    } catch {
        const privateKey = await exec('awg genkey')
        const pubkey = await exec(`echo "${privateKey}" | awg pubkey`)
        await writeFile(KEY_FILE, privateKey + '\n', { mode: 0o600 })
        await writeFile(PUBKEY_FILE, pubkey + '\n', { mode: 0o644 })
        return { privateKey, pubkey }
    }
}

/** List current mza interfaces */
export async function listInterfaces(): Promise<string[]> {
    if (USERSPACE) {
        // amneziawg-go creates TUN devices, list via /var/run/amneziawg/*.sock
        const out = await execSafe('ls /var/run/amneziawg/ 2>/dev/null')
        if (!out) return []
        return out.split('\n')
            .map(f => f.replace('.sock', ''))
            .filter(f => f.startsWith('mza'))
    }
    const out = await execSafe('ip -o link show type amneziawg')
    if (!out) return []
    return out.split('\n')
        .map(line => line.match(/^\d+:\s+(mza\d+)/)?.[1])
        .filter((x): x is string => !!x)
}

/** Enable ip forwarding globally + disable rp_filter for an interface */
async function ensureSysctl(ifName: string) {
    await execSafe('sysctl -qw net.ipv4.ip_forward=1')
    await execSafe(`sysctl -qw net.ipv4.conf.${ifName}.rp_filter=0`)
    await execSafe('sysctl -qw net.ipv4.conf.all.rp_filter=0')
}

/** Extract interface index from name: mza3 → 3 */
export function ifIndex(ifName: string): number {
    return Number(ifName.replace('mza', ''))
}

/** Get fwmark/table number for an interface */
export function getTableForIf(ifName: string): number {
    return RT_TABLE_BASE + ifIndex(ifName)
}

/** Ensure fwmark-based policy routing for an interface */
async function ensureFwmarkRouting(ifName: string) {
    const table = getTableForIf(ifName)

    // Default route via this tunnel — ONLY in its own table
    await execSafe(`ip route replace default dev ${ifName} table ${table}`)

    // fwmark rule: packets marked with this value → this table
    const rules = await execSafe(`ip rule show fwmark ${table} lookup ${table}`)
    if (!rules.includes(`lookup ${table}`)) {
        await exec(`ip rule add fwmark ${table} lookup ${table} prio ${table}`)
    }
}

/** Remove fwmark routing for an interface */
async function removeFwmarkRouting(ifName: string) {
    const table = getTableForIf(ifName)
    await execSafe(`ip route flush table ${table}`)
    let rules = await execSafe(`ip rule show lookup ${table}`)
    while (rules.includes(`lookup ${table}`)) {
        await execSafe(`ip rule del lookup ${table}`)
        rules = await execSafe(`ip rule show lookup ${table}`)
    }
}

/** Create the AWG interface (kernel module or userspace) */
async function createInterface(ifName: string) {
    if (USERSPACE) {
        // amneziawg-go runs as daemon, creates TUN device
        // WG_I_WANT_BUGGY_USERSPACE=1 forces userspace mode even when kernel wireguard exists
        await exec(`WG_I_WANT_BUGGY_USERSPACE=1 amneziawg-go ${ifName}`)
    } else {
        await exec(`ip link add ${ifName} type amneziawg`)
    }
}

export interface EnsureInterfaceOpts {
    ifName: string
    selfIpv4: string
    listenPort: number
    privateKey: string
    awg: AwgParams
    peer: PeerEndpoint
    existingInterfaces: string[]
    skipEndpoint?: boolean
}

/** Create or update an AWG interface for a specific peer */
export async function ensureInterface(opts: EnsureInterfaceOpts) {
    const { ifName, selfIpv4, listenPort, privateKey, awg, peer, existingInterfaces, skipEndpoint = false } = opts
    const isNew = !existingInterfaces.includes(ifName)
    if (isNew) {
        await createInterface(ifName)
        if (USERSPACE) {
            // Wait for UAPI socket to be ready
            for (let i = 0; i < 20; i++) {
                const sock = await execSafe(`ls /var/run/amneziawg/${ifName}.sock 2>/dev/null`)
                if (sock.includes(ifName)) break
                await new Promise(r => setTimeout(r, 100))
            }
        }
    }

    const keyPath = `${DATA_DIR}/${ifName}.key`
    await writeFile(keyPath, privateKey + '\n', { mode: 0o600 })

    const parts = [
        `awg set ${ifName}`,
        `listen-port ${listenPort}`,
        `private-key ${keyPath}`,
        `jc ${awg.jc} jmin ${awg.jmin} jmax ${awg.jmax}`,
        `s1 ${awg.s1} s2 ${awg.s2}`,
        `h1 ${awg.h1} h2 ${awg.h2} h3 ${awg.h3} h4 ${awg.h4}`,
        `peer ${peer.pubkey}`,
    ]
    if (peer.endpoint && !skipEndpoint) parts.push(`endpoint ${peer.endpoint}`)
    parts.push(
        `persistent-keepalive ${PERSISTENT_KEEPALIVE}`,
        `allowed-ips 0.0.0.0/0`,
    )
    // advanced-security is kernel-only, not supported by amneziawg-go
    if (!USERSPACE) parts.push('advanced-security on')
    await exec(parts.join(' '))

    await execSafe(`ip addr replace ${selfIpv4}/32 dev ${ifName}`)
    await execSafe(`ip link set ${ifName} up`)

    // Route peer mesh IP through this interface
    await execSafe(`ip route replace ${peer.meshIpv4}/32 dev ${ifName}`)

    await ensureSysctl(ifName)
    await ensureFwmarkRouting(ifName)
}

/** Remove an AWG interface and its routing */
export async function removeInterface(ifName: string) {
    await removeFwmarkRouting(ifName)
    await execSafe(`ip link delete ${ifName}`)
    if (USERSPACE) {
        await execSafe(`rm -f /var/run/amneziawg/${ifName}.sock`)
    }
    await execSafe(`rm -f ${DATA_DIR}/${ifName}.key`)
}

export interface PeerStats {
    ifName: string
    pubkey: string
    endpoint: string
    latestHandshake: number
    rxBytes: number
    txBytes: number
}

/** Get all peer stats in a single subprocess call via `awg show all dump` */
export async function getAllPeerStats(): Promise<Map<string, PeerStats>> {
    const result = new Map<string, PeerStats>()
    const out = await execSafe('awg show all dump')
    if (!out) return result
    // Dump output has two kinds of lines:
    // Interface line: ifName\tprivkey\tpubkey\tlistenPort\tfwmark
    // Peer line:      ifName\tpubkey\tpresharedKey\tendpoint\tallowedIPs\tlatestHandshake\trxBytes\ttxBytes\tpersistentKeepalive
    for (const line of out.split('\n')) {
        const parts = line.split('\t')
        if (parts.length >= 8) {
            // Peer line (has 9 fields, but some may be (none))
            const ifName = parts[0]?.trim()
            const pubkey = parts[1]?.trim()
            const endpoint = parts[3]?.trim() ?? ''
            const latestHandshake = Number(parts[5]?.trim() ?? 0)
            const rxBytes = Number(parts[6]?.trim() ?? 0)
            const txBytes = Number(parts[7]?.trim() ?? 0)
            if (ifName && pubkey) {
                result.set(`${ifName}\t${pubkey}`, { ifName, pubkey, endpoint, latestHandshake, rxBytes, txBytes })
            }
        }
    }
    return result
}

