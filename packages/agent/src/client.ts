import type { PeerConfig, PeerRegisterRequest } from '@meshezia/shared'

export class ApiClient {
    constructor(
        private serverUrl: string,
        private token: string
    ) {
        // Strip trailing slash
        this.serverUrl = serverUrl.replace(/\/$/, '')
    }

    private async request<T>(method: string, path: string, body?: any): Promise<T> {
        const res = await fetch(`${this.serverUrl}${path}`, {
            method,
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json'
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) {
            const text = await res.text()
            throw new Error(`API ${method} ${path}: ${res.status} ${text}`)
        }
        return res.json() as Promise<T>
    }

    async register(req: PeerRegisterRequest) {
        return this.request<any>('POST', '/api/peers', req)
    }

    async updatePeer(id: string, data: { pubkey?: string; publicIpv4?: string; memo?: string; agentVersion?: string }) {
        return this.request<any>('PATCH', `/api/peers/${id}`, data)
    }

    async getConfig(peerId: string): Promise<PeerConfig> {
        return this.request<PeerConfig>('GET', `/api/peers/${peerId}/config`)
    }

    async reportPorts(peerId: string, ports: Array<{ peerId: string; port: number }>) {
        return this.request<any>('PUT', `/api/peers/${peerId}/ports`, ports)
    }

    get wsUrl(): string {
        const base = this.serverUrl.replace(/^http/, 'ws')
        return `${base}/ws`
    }
}
