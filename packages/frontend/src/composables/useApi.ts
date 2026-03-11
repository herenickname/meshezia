import { ref, readonly } from 'vue'

const token = ref(sessionStorage.getItem('meshezia_token') ?? '')
const tokenValid = ref<boolean | null>(null) // null = unknown, true/false = checked

export function useApi() {
    async function validateToken(t: string): Promise<boolean> {
        if (!t) { tokenValid.value = null; return false }
        try {
            const res = await fetch('/api/networks', {
                headers: { 'Authorization': `Bearer ${t}` }
            })
            return res.ok
        } catch {
            return false
        }
    }

    async function setToken(t: string) {
        token.value = t
        if (!t) {
            tokenValid.value = null
            sessionStorage.removeItem('meshezia_token')
            return
        }
        const valid = await validateToken(t)
        tokenValid.value = valid
        if (valid) {
            sessionStorage.setItem('meshezia_token', t)
        } else {
            sessionStorage.removeItem('meshezia_token')
        }
    }

    // Check saved token on first load
    if (token.value && tokenValid.value === null) {
        validateToken(token.value)
            .then(valid => { tokenValid.value = valid })
            .catch(() => { tokenValid.value = false })
    }

    async function request<T>(method: string, path: string, body?: any): Promise<T> {
        const res = await fetch(path, {
            method,
            headers: {
                'Authorization': `Bearer ${token.value}`,
                'Content-Type': 'application/json'
            },
            body: body ? JSON.stringify(body) : undefined
        })
        if (!res.ok) {
            if (res.status === 401) tokenValid.value = false
            const text = await res.text()
            throw new Error(`${res.status}: ${text}`)
        }
        tokenValid.value = true
        return res.json()
    }

    return {
        token,
        tokenValid: readonly(tokenValid),
        setToken,
        get: <T>(path: string) => request<T>('GET', path),
        post: <T>(path: string, body?: any) => request<T>('POST', path, body),
        patch: <T>(path: string, body?: any) => request<T>('PATCH', path, body),
        del: <T>(path: string) => request<T>('DELETE', path)
    }
}
