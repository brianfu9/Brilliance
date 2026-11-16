// The model header's Load / Unload button (POST /admin/models/<id>/load?wait=0 | unload). The fleet
// holds one model at a time, so a load can swap out the model loaded now. The fleet scope's next
// poll shows the new state.
import { useState } from "react"
import { Download, LoaderCircle, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"

export function ModelLoad({ id, state, off }: { id: string; state?: string; off: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (off || !state) return null
  const loading = state === "loading" || state === "waiting"
  const loaded = state === "resident"
  async function act() {
    const what = loaded ? "unload" : "load"
    const ask = loaded
      ? `Unload ${id}? Requests in progress finish first; its KV cache and sessions are dropped.`
      : `Load ${id}? The fleet holds one model at a time, so this can unload the model loaded now.`
    if (!confirm(ask)) return
    setBusy(true)
    setError(null)
    try { await api(`admin/models/${encodeURIComponent(id)}/${what}${loaded ? "" : "?wait=0"}`, { method: "POST" }) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const Icon = busy || loading ? LoaderCircle : loaded ? Upload : Download
  return (
    <Button variant="outline" size="sm" disabled={busy || loading} onClick={() => void act()}
      title={error ?? (loaded ? "Unload it now (it loads again at the next request)" : "Load it now, before a request asks for it")}
      className={error ? "border-bad/60 text-bad" : undefined}>
      <Icon className={busy || loading ? "animate-spin" : undefined} />
      {loading ? "Loading…" : busy ? (loaded ? "Unloading…" : "Loading…") : loaded ? "Unload" : "Load"}
    </Button>
  )
}
