/** AWG obfuscation parameters — per-network, must match on both sides */
export interface AwgParams {
    jc: number
    jmin: number
    jmax: number
    s1: number
    s2: number
    h1: number
    h2: number
    h3: number
    h4: number
}

export interface Network extends AwgParams {
    id: string
    name: string
    subnet: string
    listenPort: number
    relayEnabled: boolean
}

export interface Peer {
    id: string
    networkId: string
    name: string
    publicIpv4: string
    pubkey: string
    meshIpv4: string
    lastSeen: number
    isRelayEligible: boolean
    ttlSeconds: number
    memo: string
    agentVersion: string
}

/** What the agent receives from GET /api/peers/:id/config */
export interface PeerConfig {
    self: {
        id: string
        meshIpv4: string
        listenPort: number
        memo: string
    }
    relayEnabled: boolean
    network: AwgParams
    peers: PeerEndpoint[]
}

export interface PeerEndpoint {
    id: string
    name: string
    pubkey: string
    meshIpv4: string
    endpoint: string
    /** Port I should listen on for this peer */
    listenPort: number
}

/** POST /api/peers — agent registration */
export interface PeerRegisterRequest {
    networkId: string
    name: string
    publicIpv4: string
    pubkey: string
    /** Seconds of inactivity before auto-deletion. 0 = permanent. */
    ttlSeconds?: number
    /** Free-form metadata for external identification/binding */
    memo?: string
    /** Agent version string */
    agentVersion?: string
}

/** POST /api/networks */
export interface NetworkCreateRequest extends AwgParams {
    name: string
    subnet: string
    listenPort: number
}

/** Full link info returned by GET /api/links */
export interface PeerLink {
    fromPeerId: string
    fromName: string
    toPeerId: string
    toName: string
    mode: 'direct' | 'relay' | 'unknown'
    directAlive: boolean
    relayAlive: boolean
    probingDirect: boolean
    rxBytes: number
    txBytes: number
    lastHandshake: number
    endpoint: string
    ifName: string
    routingTable: number
    updatedAt: number
}

/** Agent health report — sent via WS every 3s */
export interface HealthReport {
    peerId: string
    mode: 'direct' | 'relay'
    rxAlive: boolean
    relayAlive: boolean
    probingDirect: boolean
    rxBytes: number
    txBytes: number
    lastHandshake: number
    endpoint: string
    ifName: string
    routingTable: number
}

/** Relay binary frame: [36 bytes dest peer UUID][payload] */
export const RELAY_PEER_ID_LEN = 36

/** All negotiate-related WS messages */
export type NegotiateMessage =
    // Health reporting (agent → server)
    | { type: 'health-report'; reports: HealthReport[] }
    // Direct → Relay: TCP mesh probe
    | { type: 'probe-relay-serve'; with: string }
    | { type: 'probe-relay-ready'; with: string; meshIpv4: string; tcpPort: number; nonce: string }
    | { type: 'probe-relay-check'; with: string; meshIpv4: string; tcpPort: number; nonce: string; clientPubkey: string; serverPubkey: string }
    | { type: 'probe-relay-result'; with: string; success: boolean }
    // Relay → Direct: UDP public probe
    | { type: 'probe-direct-start'; with: string }
    | { type: 'probe-direct-ready'; with: string; udpPort: number; nonce: string }
    | { type: 'probe-direct-go'; with: string; peerIpv4: string; peerUdpPort: number; peerNonce: string }
    | { type: 'probe-direct-result'; with: string; success: boolean }
    // Common: verdict, error, abort, force
    | { type: 'probe-verdict'; with: string; action: 'switch-relay' | 'switch-direct' | 'stay' }
    | { type: 'probe-error'; with: string; error: string }
    | { type: 'negotiate-abort'; with: string; reason: 'admin-force' | 'timeout' | 'ws-reset' | 'peer-removed' }
    | { type: 'force-mode'; with: string; mode: 'force-direct' | 'force-relay' | 'auto' }

/** All WS text message types (negotiate + server push) */
export type RelayControlMessage =
    | NegotiateMessage
    | { type: 'peer-removed'; peerId: string }
    | { type: 'agent-update'; url: string }
