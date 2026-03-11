import { getDb } from './db'

/**
 * Parse CIDR like "10.100.0.0/24" → { base: [10,100,0,0], prefix: 24 }
 */
function parseCidr(cidr: string) {
    const [ip, prefix] = cidr.split('/')
    const octets = ip.split('.').map(Number)
    return { octets, prefix: Number(prefix) }
}

function octetsToString(o: number[]): string {
    return o.join('.')
}

function octetsToInt(o: number[]): number {
    return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0
}

function intToOctets(n: number): number[] {
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}

/**
 * Allocate the next free /32 IP from a network's subnet.
 * Skips .0 (network) and broadcast. Starts from .1.
 */
export function allocateIp(networkId: string, subnet: string): string {
    const { octets, prefix } = parseCidr(subnet)
    const base = octetsToInt(octets)
    const hostBits = 32 - prefix
    const totalHosts = (1 << hostBits) >>> 0
    // .0 = network, last = broadcast
    const firstHost = base + 1
    const lastHost = base + totalHosts - 2

    const db = getDb()
    const used = new Set(
        (db.query('SELECT ipv4 FROM peers WHERE network_id = ?').all(networkId) as { ipv4: string }[])
            .map(r => r.ipv4)
    )

    for (let ip = firstHost; ip <= lastHost; ip++) {
        const candidate = octetsToString(intToOctets(ip))
        if (!used.has(candidate)) return candidate
    }

    throw new Error(`No free IPs in subnet ${subnet}`)
}
