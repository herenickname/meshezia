<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useApi } from '../composables/useApi'

const props = defineProps<{ id: string }>()
const { get, post, patch, del } = useApi()

interface Network {
    id: string; name: string; subnet: string; listenPort: number
    relayEnabled: boolean
    jc: number; jmin: number; jmax: number; s1: number; s2: number
    h1: number; h2: number; h3: number; h4: number
}
interface Peer {
    id: string; networkId: string; name: string; publicIpv4: string
    pubkey: string; meshIpv4: string; lastSeen: number
    isRelayEligible: boolean; ttlSeconds: number; memo: string
    agentVersion: string
}
interface PeerLink {
    fromPeerId: string; fromName: string; toPeerId: string; toName: string
    mode: 'direct' | 'relay' | 'unknown'; directAlive: boolean; relayAlive: boolean
    probingDirect: boolean; rxBytes: number; txBytes: number
    lastHandshake: number; endpoint: string; ifName: string; routingTable: number
    updatedAt: number
}

const network = ref<Network | null>(null)
const peers = ref<Peer[]>([])
const links = ref<PeerLink[]>([])
const error = ref('')
const loading = ref(false)
const now = ref(Date.now())
const sortKey = ref<'name' | 'status' | 'lastSeen' | 'meshIpv4'>('status')
const sortAsc = ref(true)
const copiedField = ref('')
const expandedPeer = ref('')
const expandedPubkey = ref('')
const showAgentCmd = ref(false)
const networkToken = ref('')
const updatePeerId = ref('')
const updateUrl = ref('')
const updateDialog = ref<HTMLDialogElement>()

function isOnline(lastSeen: number): boolean {
    return lastSeen > 0 && (now.value - lastSeen) < 60_000
}
function isStale(lastSeen: number): boolean {
    return lastSeen > 0 && (now.value - lastSeen) >= 60_000 && (now.value - lastSeen) < 300_000
}

function timeAgo(agoSeconds: number, detailed = false): string {
    if (agoSeconds < 0) return 'just now'
    if (agoSeconds < 60) return `${agoSeconds}s ago`
    const m = Math.floor(agoSeconds / 60)
    if (agoSeconds < 3600) return detailed ? `${m}m ${agoSeconds % 60}s ago` : `${m}m ago`
    const h = Math.floor(agoSeconds / 3600)
    if (agoSeconds < 86400) return detailed ? `${h}h ${Math.floor((agoSeconds % 3600) / 60)}m ago` : `${h}h ago`
    const d = Math.floor(agoSeconds / 86400)
    return `${d}d ${Math.floor((agoSeconds % 86400) / 3600)}h ago`
}

function peerAge(lastSeen: number): string {
    if (!lastSeen) return 'never'
    return timeAgo(Math.floor((now.value - lastSeen) / 1000), true)
}

function ttlDisplay(p: Peer): string {
    if (!p.ttlSeconds) return 'permanent'
    if (!p.lastSeen) return `TTL ${p.ttlSeconds}s`
    const elapsed = Math.floor((now.value - p.lastSeen) / 1000)
    const remaining = p.ttlSeconds - elapsed
    if (remaining <= 0) return 'expiring\u2026'
    if (remaining < 60) return `${remaining}s left`
    if (remaining < 3600) return `${Math.floor(remaining / 60)}m left`
    return `${Math.floor(remaining / 3600)}h left`
}

function statusOrder(p: Peer): number {
    if (isOnline(p.lastSeen)) return 0
    if (isStale(p.lastSeen)) return 1
    return 2
}

const sortedPeers = computed(() => {
    const arr = [...peers.value]
    arr.sort((a, b) => {
        let cmp = 0
        switch (sortKey.value) {
            case 'name': cmp = a.name.localeCompare(b.name); break
            case 'status': cmp = statusOrder(a) - statusOrder(b); break
            case 'lastSeen': cmp = (b.lastSeen || 0) - (a.lastSeen || 0); break
            case 'meshIpv4': cmp = a.meshIpv4.localeCompare(b.meshIpv4); break
        }
        return sortAsc.value ? cmp : -cmp
    })
    return arr
})

const onlineCount = computed(() => peers.value.filter(p => isOnline(p.lastSeen)).length)
const staleCount = computed(() => peers.value.filter(p => isStale(p.lastSeen)).length)
const offlineCount = computed(() => peers.value.length - onlineCount.value - staleCount.value)
const relayCount = computed(() => peers.value.filter(p => p.isRelayEligible).length)

const directLinkCount = computed(() => links.value.filter(l => l.mode === 'direct').length)
const relayLinkCount = computed(() => links.value.filter(l => l.mode === 'relay').length)

const linksByPeer = computed(() => {
    const map = new Map<string, PeerLink[]>()
    for (const l of links.value) {
        const arr = map.get(l.fromPeerId)
        if (arr) arr.push(l)
        else map.set(l.fromPeerId, [l])
    }
    return map
})

function linksForPeer(peerId: string): PeerLink[] {
    return linksByPeer.value.get(peerId) ?? []
}

function togglePeerExpand(peerId: string) {
    expandedPeer.value = expandedPeer.value === peerId ? '' : peerId
}

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
    return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)}\u00a0${units[i]}`
}

function handshakeAge(ts: number): string {
    if (!ts) return 'never'
    return timeAgo(Math.floor(now.value / 1000) - ts)
}

function isLinkStale(updatedAt: number): boolean {
    return (now.value - updatedAt) > 60_000
}

async function forceModeSwitch(link: PeerLink, mode: 'force-direct' | 'force-relay' | 'auto') {
    const label = mode === 'force-direct' ? 'direct' : mode === 'force-relay' ? 'relay' : 'auto'
    if (!confirm(`Switch ${link.fromName} \u2192 ${link.toName} to ${label}?`)) return
    try {
        await post('/api/links/force-mode', {
            peerA: link.fromPeerId,
            peerB: link.toPeerId,
            mode
        })
    } catch (e: any) {
        error.value = e.message
    }
}

async function toggleRelay() {
    if (!network.value) return
    try {
        const updated = await patch<Network>(`/api/networks/${network.value.id}`, {
            relayEnabled: !network.value.relayEnabled
        })
        network.value = updated
    } catch (e: any) {
        error.value = e.message
    }
}

const awgParams = computed(() => {
    if (!network.value) return ''
    const n = network.value
    return `Jc=${n.jc} Jmin=${n.jmin} Jmax=${n.jmax} S1=${n.s1} S2=${n.s2} H1=${n.h1} H2=${n.h2} H3=${n.h3} H4=${n.h4}`
})

const agentCmd = computed(() => {
    if (!network.value) return ''
    return `meshezia-agent \\
  --server=http://<control-plane>:3000 \\
  --token=${networkToken.value || '<click Copy Token>'} \\
  --network=${network.value.id} \\
  --name=<node-name> \\
  --ipv4=<public-ip>`
})

async function fetchAndCopyToken() {
    if (!network.value) return
    try {
        const { token } = await get<{ token: string }>(`/api/networks/${network.value.id}/token`)
        networkToken.value = token
        await copyText(token, 'token')
    } catch (e: any) {
        error.value = e.message
    }
}

async function load() {
    loading.value = true
    try {
        const [net, p, l] = await Promise.all([
            get<Network>(`/api/networks/${props.id}`),
            get<Peer[]>(`/api/peers?network_id=${props.id}`),
            get<PeerLink[]>(`/api/links?network_id=${props.id}`)
        ])
        network.value = net
        peers.value = p
        links.value = l
        error.value = ''
    } catch (e: any) {
        error.value = e.message
    } finally {
        loading.value = false
    }
}

function openUpdateDialog(peerId: string) {
    updatePeerId.value = peerId
    updateUrl.value = ''
    updateDialog.value?.showModal()
}

async function submitUpdate() {
    if (!updateUrl.value.trim()) return
    try {
        await post(`/api/peers/${updatePeerId.value}/update`, { url: updateUrl.value.trim() })
        updateDialog.value?.close()
        updatePeerId.value = ''
    } catch (e: any) {
        error.value = e.message
    }
}

async function removePeer(peerId: string) {
    if (!confirm('Remove this peer?')) return
    try {
        await del(`/api/peers/${peerId}`)
        await load()
    } catch (e: any) {
        error.value = e.message
    }
}

async function copyText(text: string, field: string) {
    await navigator.clipboard.writeText(text)
    copiedField.value = field
    setTimeout(() => { if (copiedField.value === field) copiedField.value = '' }, 2000)
}

function toggleSort(key: typeof sortKey.value) {
    if (sortKey.value === key) sortAsc.value = !sortAsc.value
    else { sortKey.value = key; sortAsc.value = true }
}

function sortIcon(key: typeof sortKey.value): string {
    if (sortKey.value !== key) return '\u2195'
    return sortAsc.value ? '\u2191' : '\u2193'
}

function ariaSort(key: typeof sortKey.value): 'ascending' | 'descending' | 'none' {
    if (sortKey.value !== key) return 'none'
    return sortAsc.value ? 'ascending' : 'descending'
}

let refreshTimer: ReturnType<typeof setInterval>
let tickTimer: ReturnType<typeof setInterval>

onMounted(() => {
    load()
    refreshTimer = setInterval(load, 5_000)
    tickTimer = setInterval(() => { now.value = Date.now() }, 1_000)
})
onUnmounted(() => {
    clearInterval(refreshTimer)
    clearInterval(tickTimer)
})
</script>

<template>
    <div v-if="network">
        <div class="mb-4">
            <router-link to="/" class="text-[13px] text-gray-500 hover:text-blue-500">&larr; Networks</router-link>
        </div>

        <!-- Network header -->
        <div class="card">
            <div class="flex justify-between items-start">
                <div>
                    <h2 class="text-xl font-bold">{{ network.name }}</h2>
                    <div class="font-mono text-xs text-gray-500 mt-1">
                        {{ network.subnet }}
                    </div>
                </div>
                <div class="flex gap-1.5">
                    <button class="btn btn-secondary btn-sm" @click="fetchAndCopyToken">
                        {{ copiedField === 'token' ? 'Copied!' : 'Copy Token' }}
                    </button>
                    <button class="btn btn-secondary btn-sm" @click="copyText(network.id, 'netid')">
                        {{ copiedField === 'netid' ? 'Copied!' : 'Copy ID' }}
                    </button>
                    <button class="btn btn-secondary btn-sm" @click="load" :disabled="loading">
                        {{ loading ? '\u2026' : 'Refresh' }}
                    </button>
                </div>
            </div>

            <div class="mt-3 pt-3 border-t border-gray-200 flex justify-between items-center">
                <span class="font-mono text-[11px] text-gray-500">{{ awgParams }}</span>
                <button
                    class="btn btn-sm"
                    :class="network.relayEnabled ? 'bg-green-600 hover:bg-green-700' : 'bg-gray-400 hover:bg-gray-500'"
                    @click="toggleRelay"
                    :title="network.relayEnabled ? 'Relay is enabled — nodes can fail over to relay when direct path is dead' : 'Relay is disabled — nodes always stay on direct, even without handshakes'"
                >
                    Relay {{ network.relayEnabled ? 'ON' : 'OFF' }}
                </button>
            </div>
        </div>

        <!-- Stats -->
        <div class="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-3 mb-4">
            <div class="stat-card">
                <div class="stat-label">Peers</div>
                <div class="stat-value text-blue-500">{{ peers.length }}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Online</div>
                <div class="stat-value text-green-600">{{ onlineCount }}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Stale (&lt;5m)</div>
                <div class="stat-value text-amber-600">{{ staleCount }}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Offline</div>
                <div class="stat-value" :class="offlineCount > 0 ? 'text-red-500' : ''">{{ offlineCount }}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Relay Eligible</div>
                <div class="stat-value">{{ relayCount }}</div>
            </div>
        </div>

        <!-- Agent command -->
        <div class="card py-3.5 px-5">
            <button
                type="button"
                :aria-expanded="showAgentCmd"
                @click="showAgentCmd = !showAgentCmd"
                class="btn-reset w-full flex justify-between items-center"
            >
                <span class="text-[13px] text-gray-500">Agent command</span>
                <span class="text-gray-500 text-xs">{{ showAgentCmd ? '\u25BE' : '\u25B8' }}</span>
            </button>
            <div v-if="showAgentCmd" class="mt-2.5">
                <div class="relative">
                    <pre class="font-mono p-3 bg-gray-100 border border-gray-200 rounded-md overflow-x-auto text-xs leading-relaxed">{{ agentCmd }}</pre>
                    <button class="btn btn-secondary btn-sm absolute top-2 right-2" @click="copyText(agentCmd, 'cmd')">
                        {{ copiedField === 'cmd' ? 'Copied!' : 'Copy' }}
                    </button>
                </div>
            </div>
        </div>

        <p v-if="error" role="alert" class="text-red-600 my-2 text-[13px]">{{ error }}</p>

        <!-- Peers header -->
        <div class="flex justify-between items-center mt-5 mb-3">
            <h3 class="text-base font-semibold">
                Peers
                <span class="text-gray-500 font-normal text-sm">({{ peers.length }})</span>
            </h3>
            <div class="flex items-center gap-2 text-[11px] text-gray-500">
                <span class="inline-block size-1.5 rounded-full bg-green-600 animate-pulse"></span>
                <span>auto-refresh 5s</span>
            </div>
        </div>

        <!-- Empty state -->
        <div v-if="peers.length === 0" class="card p-12 text-center">
            <div class="text-[32px] mb-2 opacity-30" aria-hidden="true">&#9671;</div>
            <p class="text-gray-500">No peers yet. Run the agent on a node to register.</p>
        </div>

        <!-- Peer table -->
        <table v-if="peers.length > 0" class="table-fixed">
            <colgroup>
                <col style="width: 180px" /><!-- Name -->
                <col style="width: 80px" /><!-- Status -->
                <col style="width: 110px" /><!-- Mesh IP -->
                <col style="width: 130px" /><!-- Public IP -->
                <col style="width: 140px" /><!-- Pubkey -->
                <col style="width: 100px" /><!-- Last Seen -->
                <col style="width: 80px" /><!-- TTL -->
                <col style="width: 120px" /><!-- Memo -->
                <col style="width: 150px" /><!-- Actions -->
            </colgroup>
            <thead>
                <tr>
                    <th :aria-sort="ariaSort('name')"><button type="button" class="btn-reset w-full text-left cursor-pointer" @click="toggleSort('name')">Name {{ sortIcon('name') }}</button></th>
                    <th :aria-sort="ariaSort('status')"><button type="button" class="btn-reset w-full text-left cursor-pointer" @click="toggleSort('status')">Status {{ sortIcon('status') }}</button></th>
                    <th :aria-sort="ariaSort('meshIpv4')"><button type="button" class="btn-reset w-full text-left cursor-pointer" @click="toggleSort('meshIpv4')">Mesh IP {{ sortIcon('meshIpv4') }}</button></th>
                    <th>Public IP</th>
                    <th>Pubkey</th>
                    <th :aria-sort="ariaSort('lastSeen')"><button type="button" class="btn-reset w-full text-left cursor-pointer" @click="toggleSort('lastSeen')">Last Seen {{ sortIcon('lastSeen') }}</button></th>
                    <th>TTL</th>
                    <th>Memo</th>
                    <th aria-label="Actions"></th>
                </tr>
            </thead>
            <tbody>
                <template v-for="p in sortedPeers" :key="p.id">
                    <tr
                        class="cursor-pointer hover:bg-gray-50 transition-[background-color]"
                        :class="expandedPeer === p.id ? 'bg-gray-50' : ''"
                        @click="togglePeerExpand(p.id)"
                    >
                        <td>
                            <button
                                type="button"
                                class="btn-reset font-medium"
                                :aria-expanded="expandedPeer === p.id"
                                :aria-label="`${expandedPeer === p.id ? 'Collapse' : 'Expand'} ${p.name}`"
                                @click.stop="togglePeerExpand(p.id)"
                            >
                                {{ p.name }}
                                <span class="text-gray-500 text-xs ml-1.5" aria-hidden="true">{{ expandedPeer === p.id ? '\u25BE' : '\u25B8' }}</span>
                            </button>
                            <span v-if="p.agentVersion" class="text-[10px] text-gray-400 ml-1">v{{ p.agentVersion }}</span>
                            <span
                                v-if="p.isRelayEligible"
                                class="inline-flex items-center justify-center size-4 rounded bg-blue-100 text-blue-500 text-[9px] font-bold ml-1.5 align-middle"
                                title="Relay eligible"
                                aria-label="Relay eligible"
                            >R</span>
                        </td>
                        <td>
                            <span v-if="isOnline(p.lastSeen)" class="badge badge-online">online</span>
                            <span v-else-if="isStale(p.lastSeen)" class="badge badge-stale">stale</span>
                            <span v-else class="badge badge-offline">offline</span>
                        </td>
                        <td class="font-mono text-xs">{{ p.meshIpv4 }}</td>
                        <td class="font-mono text-xs">{{ p.publicIpv4 || '—' }}</td>
                        <td class="font-mono text-xs" @click.stop>
                            <button
                                type="button"
                                class="btn-reset hover:text-blue-500 font-mono text-xs"
                                @click="expandedPubkey === p.id ? expandedPubkey = '' : expandedPubkey = p.id"
                                :title="p.pubkey || 'no key'"
                            >
                                {{ p.pubkey ? (expandedPubkey === p.id ? p.pubkey : p.pubkey.slice(0, 12) + '\u2026') : '\u2014' }}
                            </button>
                            <button
                                v-if="p.pubkey && expandedPubkey === p.id"
                                class="btn btn-secondary ml-1 py-1 px-2 text-[10px] min-h-6"
                                @click.stop="copyText(p.pubkey, `pk-${p.id}`)"
                            >
                                {{ copiedField === `pk-${p.id}` ? '\u2713' : 'copy' }}
                            </button>
                        </td>
                        <td style="font-variant-numeric: tabular-nums">
                            <span :class="isOnline(p.lastSeen) ? '' : 'text-gray-500'">{{ peerAge(p.lastSeen) }}</span>
                        </td>
                        <td>
                            <span :class="[
                                'text-xs text-gray-500',
                                p.ttlSeconds && p.lastSeen && (p.ttlSeconds - Math.floor((now - p.lastSeen) / 1000)) < 120 ? 'text-amber-600 font-medium' : ''
                            ]">
                                {{ ttlDisplay(p) }}
                            </span>
                        </td>
                        <td>
                            <span class="text-xs text-gray-500 max-w-[150px] overflow-hidden text-ellipsis whitespace-nowrap inline-block align-middle" :title="p.memo">{{ p.memo || '—' }}</span>
                        </td>
                        <td class="flex gap-1.5 min-w-[140px]" @click.stop>
                            <button v-if="isOnline(p.lastSeen)" class="btn btn-secondary btn-sm" :aria-label="`Update ${p.name}`" @click="openUpdateDialog(p.id)">Update</button>
                            <button class="btn btn-danger btn-sm" :aria-label="`Remove ${p.name}`" @click="removePeer(p.id)">Remove</button>
                        </td>
                    </tr>
                    <!-- Expanded peer connections -->
                    <tr v-if="expandedPeer === p.id">
                        <td colspan="9" class="!p-0">
                            <div class="bg-gray-50 border-t border-b border-gray-200 px-5 py-3">
                                <div v-if="linksForPeer(p.id).length === 0" class="text-xs text-gray-500 py-2">
                                    No connection data from this peer yet.
                                </div>
                                <div v-else class="overflow-x-auto">
                                <table class="w-full text-xs table-compact table-fixed">
                                    <colgroup>
                                        <col style="width: 160px" /><!-- To -->
                                        <col style="width: 70px" /><!-- Interface -->
                                        <col style="width: 60px" /><!-- Table -->
                                        <col style="width: 80px" /><!-- Mode -->
                                        <col style="width: 180px" /><!-- Endpoint -->
                                        <col style="width: 90px" /><!-- Handshake -->
                                        <col style="width: 150px" /><!-- RX / TX -->
                                        <col style="width: 80px" /><!-- Updated -->
                                        <col style="width: 120px" /><!-- Actions -->
                                    </colgroup>
                                    <thead>
                                        <tr>
                                            <th class="text-[11px]">To</th>
                                            <th class="text-[11px]">Interface</th>
                                            <th class="text-[11px]">Table</th>
                                            <th class="text-[11px]">Mode</th>
                                            <th class="text-[11px]">Endpoint</th>
                                            <th class="text-[11px]">Handshake</th>
                                            <th class="text-[11px]">RX / TX</th>
                                            <th class="text-[11px]">Updated</th>
                                            <th aria-label="Actions"></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr v-for="l in linksForPeer(p.id)" :key="l.toPeerId" :class="isLinkStale(l.updatedAt) ? 'opacity-50' : ''">
                                            <td class="font-medium">{{ l.toName }}</td>
                                            <td class="font-mono">{{ l.ifName || '—' }}</td>
                                            <td class="font-mono">{{ l.routingTable || '—' }}</td>
                                            <td>
                                                <span v-if="l.probingDirect" class="badge bg-blue-100 text-blue-700" title="Probing direct path">probing</span>
                                                <span v-else-if="l.mode === 'direct'" class="badge badge-online">direct</span>
                                                <span v-else-if="l.mode === 'relay'" class="badge badge-stale">relay</span>
                                                <span v-else class="badge bg-gray-100 text-gray-500">unknown</span>
                                            </td>
                                            <td class="font-mono truncate">{{ l.endpoint || '—' }}</td>
                                            <td style="font-variant-numeric: tabular-nums">{{ handshakeAge(l.lastHandshake) }}</td>
                                            <td class="font-mono whitespace-nowrap" style="font-variant-numeric: tabular-nums">{{ formatBytes(l.rxBytes) }} / {{ formatBytes(l.txBytes) }}</td>
                                            <td class="text-gray-500" style="font-variant-numeric: tabular-nums">{{ peerAge(l.updatedAt) }}</td>
                                            <td @click.stop>
                                                <div class="flex gap-1">
                                                    <button
                                                        v-if="l.mode === 'relay' || l.probingDirect"
                                                        class="btn btn-sm bg-green-600 hover:bg-green-700 text-[10px] py-1 px-2 min-h-7"
                                                        @click="forceModeSwitch(l, 'force-direct')"
                                                        title="Force switch to direct"
                                                    >Force Direct</button>
                                                    <button
                                                        v-if="l.mode === 'direct' && !l.probingDirect"
                                                        class="btn btn-sm bg-amber-600 hover:bg-amber-700 text-[10px] py-1 px-2 min-h-7"
                                                        @click="forceModeSwitch(l, 'force-relay')"
                                                        title="Force switch to relay"
                                                    >Force Relay</button>
                                                </div>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                                </div>
                            </div>
                        </td>
                    </tr>
                </template>
            </tbody>
        </table>


        <!-- Network ID -->
        <div class="mt-6 text-center">
            <span class="font-mono text-gray-500 text-[11px]">Network ID: {{ network.id }}</span>
        </div>

        <!-- Update agent dialog -->
        <dialog ref="updateDialog" class="rounded-xl border border-gray-200 p-0 shadow-lg" @close="updatePeerId = ''">
            <div class="p-5 w-[400px]">
                <h3 class="text-sm font-semibold mb-3">Update Agent</h3>
                <form @submit.prevent="submitUpdate">
                    <label class="flex flex-col gap-1 mb-3">
                        <span class="form-label">Download URL</span>
                        <input v-model="updateUrl" type="url" required name="update-url" placeholder="https://\u2026" class="input w-full" autocomplete="off" />
                    </label>
                    <div class="flex justify-end gap-1.5">
                        <button type="button" class="btn btn-secondary btn-sm" @click="updateDialog?.close()">Cancel</button>
                        <button type="submit" class="btn btn-sm">Update</button>
                    </div>
                </form>
            </div>
        </dialog>
    </div>
</template>
