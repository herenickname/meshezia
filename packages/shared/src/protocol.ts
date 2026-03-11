import { RELAY_PEER_ID_LEN } from './types'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Encode a relay frame: [36-byte dest peer UUID][AWG payload]
 * AWG payload is opaque encrypted bytes — relay never inspects it.
 */
export function encodeRelayFrame(destPeerId: string, payload: Uint8Array): Uint8Array {
    const header = encoder.encode(destPeerId)
    const frame = new Uint8Array(header.length + payload.length)
    frame.set(header, 0)
    frame.set(payload, header.length)
    return frame
}

/**
 * Decode a relay frame → { destPeerId, payload }
 */
export function decodeRelayFrame(frame: Uint8Array): { destPeerId: string; payload: Uint8Array } {
    const destPeerId = decoder.decode(frame.subarray(0, RELAY_PEER_ID_LEN))
    const payload = frame.subarray(RELAY_PEER_ID_LEN)
    return { destPeerId, payload }
}
