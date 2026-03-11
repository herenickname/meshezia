<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useApi } from '../composables/useApi'

const { get, post, del } = useApi()

interface Network {
    id: string; name: string; subnet: string; listenPort: number
    jc: number; jmin: number; jmax: number; s1: number; s2: number
    h1: number; h2: number; h3: number; h4: number
}
interface Peer {
    id: string; networkId: string; name: string; publicIpv4: string
    pubkey: string; meshIpv4: string; lastSeen: number
    isRelayEligible: boolean; ttlSeconds: number
}

const networks = ref<Network[]>([])
const allPeers = ref<Peer[]>([])
const error = ref('')
const showCreate = ref(false)
const loading = ref(false)
const lastRefresh = ref(0)
const copiedId = ref('')

const form = ref({
    name: '',
    subnet: '10.100.0.0/23',
    jc: null as number | null, jmin: null as number | null, jmax: null as number | null,
    s1: null as number | null, s2: null as number | null,
    h1: null as number | null, h2: null as number | null, h3: null as number | null, h4: null as number | null
})

function peersForNetwork(networkId: string): Peer[] {
    return allPeers.value.filter(p => p.networkId === networkId)
}
function onlineCount(networkId: string): number {
    return peersForNetwork(networkId).filter(p => p.lastSeen > 0 && (Date.now() - p.lastSeen) < 60_000).length
}

const totalPeers = computed(() => allPeers.value.length)
const totalOnline = computed(() => allPeers.value.filter(p => p.lastSeen > 0 && (Date.now() - p.lastSeen) < 60_000).length)

async function load() {
    loading.value = true
    try {
        const [nets, peers] = await Promise.all([
            get<Network[]>('/api/networks'),
            get<Peer[]>('/api/peers')
        ])
        networks.value = nets
        allPeers.value = peers
        error.value = ''
        lastRefresh.value = Date.now()
    } catch (e: any) {
        error.value = e.message
    } finally {
        loading.value = false
    }
}

async function create() {
    try {
        // Strip null values so backend generates defaults
        const body = Object.fromEntries(
            Object.entries(form.value).filter(([_, v]) => v != null && v !== '')
        )
        await post('/api/networks', body)
        showCreate.value = false
        form.value.name = ''
        await load()
    } catch (e: any) {
        error.value = e.message
    }
}

async function remove(id: string) {
    if (!confirm('Delete this network and all its peers?')) return
    try {
        await del(`/api/networks/${id}`)
        await load()
    } catch (e: any) {
        error.value = e.message
    }
}

async function copyToken(id: string) {
    try {
        const { token } = await get<{ token: string }>(`/api/networks/${id}/token`)
        await navigator.clipboard.writeText(token)
        copiedId.value = id
        setTimeout(() => { if (copiedId.value === id) copiedId.value = '' }, 2000)
    } catch (e: any) {
        error.value = e.message
    }
}

function onBeforeUnload(e: BeforeUnloadEvent) {
    e.preventDefault()
}

watch(() => showCreate.value && form.value.name !== '', (dirty) => {
    if (dirty) window.addEventListener('beforeunload', onBeforeUnload)
    else window.removeEventListener('beforeunload', onBeforeUnload)
})

let refreshTimer: ReturnType<typeof setInterval>

onMounted(() => {
    load()
    refreshTimer = setInterval(load, 10_000)
})
onUnmounted(() => {
    clearInterval(refreshTimer)
    window.removeEventListener('beforeunload', onBeforeUnload)
})
</script>

<template>
    <div>
        <!-- Stats -->
        <div class="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-3 mb-4" v-if="networks.length > 0">
            <div class="stat-card">
                <div class="stat-label">Networks</div>
                <div class="stat-value text-blue-500">{{ networks.length }}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Total Peers</div>
                <div class="stat-value">{{ totalPeers }}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Online</div>
                <div class="stat-value text-green-600">{{ totalOnline }}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Offline</div>
                <div class="stat-value" :class="totalPeers - totalOnline > 0 ? 'text-red-500' : ''">{{ totalPeers - totalOnline }}</div>
            </div>
        </div>

        <!-- Header -->
        <div class="flex justify-between items-center mb-4">
            <div class="flex items-center gap-3">
                <h2 class="text-lg font-semibold">Networks</h2>
                <div class="flex items-center gap-2 text-[11px] text-gray-500">
                    <span class="inline-block size-1.5 rounded-full bg-green-600 animate-pulse"></span>
                    <span>auto-refresh 10s</span>
                </div>
            </div>
            <div class="flex gap-1.5">
                <button class="btn btn-secondary btn-sm" @click="load" :disabled="loading">
                    {{ loading ? '\u2026' : 'Refresh' }}
                </button>
                <button class="btn btn-sm" @click="showCreate = !showCreate">
                    {{ showCreate ? 'Cancel' : '+ Network' }}
                </button>
            </div>
        </div>

        <p v-if="error" role="alert" class="text-red-600 my-2 text-[13px]">{{ error }}</p>

        <!-- Create form -->
        <div v-if="showCreate" class="card border-blue-500/20">
            <h3 class="text-sm font-semibold mb-3">Create Network</h3>
            <form @submit.prevent="create" autocomplete="off">
                <div class="flex gap-3 mb-3 items-end flex-wrap">
                    <label class="flex flex-col gap-1 flex-[2]">
                        <span class="form-label">Name</span>
                        <input v-model="form.name" required name="network-name" placeholder="production\u2026" class="input w-full" />
                    </label>
                    <label class="flex flex-col gap-1 flex-[2]">
                        <span class="form-label">Subnet (CIDR)</span>
                        <input v-model="form.subnet" required name="subnet" placeholder="10.100.0.0/23…" class="input w-full" />
                    </label>
                </div>
                <div class="mb-2">
                    <span class="form-label">AWG Obfuscation</span>
                    <span class="text-[11px] text-gray-500 ml-1.5">leave empty for auto-generate</span>
                </div>
                <div class="flex gap-3 mb-3 items-end flex-wrap">
                    <label class="flex flex-col gap-1"><span class="form-label">Jc</span><input v-model.number="form.jc" type="number" inputmode="numeric" name="jc" placeholder="auto…" class="input w-20" /></label>
                    <label class="flex flex-col gap-1"><span class="form-label">Jmin</span><input v-model.number="form.jmin" type="number" inputmode="numeric" name="jmin" placeholder="auto…" class="input w-20" /></label>
                    <label class="flex flex-col gap-1"><span class="form-label">Jmax</span><input v-model.number="form.jmax" type="number" inputmode="numeric" name="jmax" placeholder="auto…" class="input w-20" /></label>
                    <label class="flex flex-col gap-1"><span class="form-label">S1</span><input v-model.number="form.s1" type="number" inputmode="numeric" name="s1" placeholder="auto…" class="input w-20" /></label>
                    <label class="flex flex-col gap-1"><span class="form-label">S2</span><input v-model.number="form.s2" type="number" inputmode="numeric" name="s2" placeholder="auto…" class="input w-20" /></label>
                </div>
                <div class="flex gap-3 mb-3 items-end flex-wrap">
                    <label class="flex flex-col gap-1"><span class="form-label">H1</span><input v-model.number="form.h1" type="number" inputmode="numeric" name="h1" placeholder="auto…" class="input w-20" /></label>
                    <label class="flex flex-col gap-1"><span class="form-label">H2</span><input v-model.number="form.h2" type="number" inputmode="numeric" name="h2" placeholder="auto…" class="input w-20" /></label>
                    <label class="flex flex-col gap-1"><span class="form-label">H3</span><input v-model.number="form.h3" type="number" inputmode="numeric" name="h3" placeholder="auto…" class="input w-20" /></label>
                    <label class="flex flex-col gap-1"><span class="form-label">H4</span><input v-model.number="form.h4" type="number" inputmode="numeric" name="h4" placeholder="auto…" class="input w-20" /></label>
                    <div class="ml-auto"><button type="submit" class="btn">Create</button></div>
                </div>
            </form>
        </div>

        <!-- Empty state -->
        <div v-if="networks.length === 0 && !error" class="card p-12 text-center">
            <div class="text-[32px] mb-2 opacity-30" aria-hidden="true">&#9670;</div>
            <p class="text-gray-500">No networks yet. Enter your admin token above and create one.</p>
        </div>

        <!-- Network cards -->
        <div v-for="n in networks" :key="n.id" class="card transition-colors hover:border-gray-300">
            <div class="flex justify-between items-start">
                <div>
                    <router-link :to="`/networks/${n.id}`" class="text-base font-semibold text-gray-900 hover:text-blue-500">
                        {{ n.name }}
                    </router-link>
                    <div class="font-mono text-xs text-gray-500 mt-1">
                        {{ n.subnet }}
                    </div>
                </div>
                <div class="flex gap-1.5">
                    <button class="btn btn-secondary btn-sm" @click="copyToken(n.id)">
                        {{ copiedId === n.id ? 'Copied!' : 'Copy Token' }}
                    </button>
                    <button class="btn btn-danger btn-sm" @click="remove(n.id)">Delete</button>
                </div>
            </div>
            <div class="flex gap-6 mt-3.5 pt-3 border-t border-gray-200">
                <div class="flex items-baseline gap-1">
                    <span class="text-lg font-bold text-gray-900" style="font-variant-numeric: tabular-nums">{{ peersForNetwork(n.id).length }}</span>
                    <span class="text-[11px] text-gray-500">peers</span>
                </div>
                <div class="flex items-baseline gap-1">
                    <span class="text-lg font-bold text-green-600" style="font-variant-numeric: tabular-nums">{{ onlineCount(n.id) }}</span>
                    <span class="text-[11px] text-gray-500">online</span>
                </div>
                <div class="flex items-baseline gap-1">
                    <span class="text-lg font-bold" style="font-variant-numeric: tabular-nums" :class="peersForNetwork(n.id).length - onlineCount(n.id) > 0 ? 'text-red-500' : 'text-gray-900'">
                        {{ peersForNetwork(n.id).length - onlineCount(n.id) }}
                    </span>
                    <span class="text-[11px] text-gray-500">offline</span>
                </div>
                <div class="ml-auto font-mono text-[11px] text-gray-500 self-center">
                    Jc={{ n.jc }} Jmin={{ n.jmin }} Jmax={{ n.jmax }} S1={{ n.s1 }} S2={{ n.s2 }}
                </div>
            </div>
        </div>
    </div>
</template>
