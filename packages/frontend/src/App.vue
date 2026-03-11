<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useApi } from './composables/useApi'

const { token, tokenValid, setToken } = useApi()

const version = __APP_VERSION__
const inputToken = ref('')
const loggingIn = ref(false)
const loginError = ref('')
const tokenInputEl = ref<HTMLInputElement>()

async function login() {
    if (!inputToken.value.trim()) return
    loggingIn.value = true
    loginError.value = ''
    await setToken(inputToken.value.trim())
    loggingIn.value = false
    if (tokenValid.value !== true) {
        loginError.value = 'Invalid token \u2014 check and try again'
    }
}

function logout() {
    inputToken.value = ''
    setToken('')
}

onMounted(() => {
    if (window.innerWidth > 768) tokenInputEl.value?.focus()
})
</script>

<template>
    <!-- Login screen -->
    <div v-if="tokenValid !== true" class="min-h-screen flex items-center justify-center">
        <div class="w-[360px] text-center">
            <div class="flex items-center justify-center gap-2.5 mb-2">
                <span class="text-4xl text-blue-500" aria-hidden="true">&#9670;</span>
                <h1 class="text-[28px] font-bold -tracking-wide text-gray-900">Meshezia</h1>
            </div>
            <p class="text-[13px] text-gray-500 mb-8">AmneziaWG Mesh VPN Control Plane</p>
            <form @submit.prevent="login" class="flex flex-col gap-3">
                <input
                    ref="tokenInputEl"
                    v-model="inputToken"
                    type="password"
                    name="token"
                    autocomplete="current-password"
                    placeholder="Enter admin token…"
                    aria-label="Admin token"
                    :disabled="loggingIn"
                    class="input px-4 py-3 rounded-lg text-sm text-center w-full"
                />
                <button
                    type="submit"
                    :disabled="loggingIn || !inputToken.trim()"
                    class="btn py-3 rounded-lg text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {{ loggingIn ? 'Checking\u2026' : 'Sign In' }}
                </button>
            </form>
            <p v-if="loginError" role="alert" class="text-red-600 text-[13px] mt-3">{{ loginError }}</p>
        </div>
    </div>

    <!-- Dashboard -->
    <div v-else class="max-w-[1060px] mx-auto px-6 py-4">
        <header class="flex items-center justify-between py-3 border-b border-gray-200 mb-6">
            <div class="flex items-center gap-4">
                <router-link to="/" class="flex items-center gap-2 text-gray-800 hover:text-gray-900 no-underline">
                    <span class="text-blue-500 text-lg" aria-hidden="true">&#9670;</span>
                    <h1 class="text-lg font-semibold -tracking-wide">Meshezia</h1>
                </router-link>
                <span class="text-xs text-gray-500 font-mono">v{{ version }}</span>
            </div>
            <button class="btn btn-secondary btn-sm" @click="logout">Logout</button>
        </header>
        <main id="main-content">
            <router-view />
        </main>
    </div>
</template>
