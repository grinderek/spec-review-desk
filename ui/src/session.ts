export async function ensureSession(): Promise<string | null> {
  const url = new URL(window.location.href)
  const token = url.searchParams.get('t')
  if (!token) return null
  try {
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    return res.ok ? null : 'The sign-in link was refused — restart the server and open the new URL it prints.'
  } finally {
    url.searchParams.delete('t')
    window.history.replaceState(null, '', url.toString())
  }
}
