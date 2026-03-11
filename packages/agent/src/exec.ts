/**
 * Run a shell command, return stdout. Throws on non-zero exit.
 */
export async function exec(cmd: string): Promise<string> {
    const proc = Bun.spawn(['sh', '-c', cmd], {
        stdout: 'pipe',
        stderr: 'pipe'
    })
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const code = await proc.exited
    if (code !== 0) {
        throw new Error(`Command failed (${code}): ${cmd}\n${stderr}`)
    }
    return stdout.trim()
}

/** Run command, ignore errors */
export async function execSafe(cmd: string): Promise<string> {
    try {
        return await exec(cmd)
    } catch {
        return ''
    }
}
