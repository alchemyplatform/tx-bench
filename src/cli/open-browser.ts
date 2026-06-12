export type BrowserSpawn = (command: string[]) => Promise<number>

function defaultCommand(url: string): string[] {
  switch (process.platform) {
    case 'darwin':
      return ['open', url]
    case 'win32':
      return ['cmd', '/c', 'start', '', url]
    default:
      return ['xdg-open', url]
  }
}

const defaultSpawn: BrowserSpawn = async command => {
  const proc = Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' })
  return await proc.exited
}

export async function openBrowser(url: string, spawn: BrowserSpawn = defaultSpawn): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const exitCode = await spawn(defaultCommand(url))
    if (exitCode === 0) return { ok: true }
    return { ok: false, error: `browser opener exited with code ${exitCode}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
