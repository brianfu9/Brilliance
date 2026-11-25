// A model's Load / Unload button (POST /admin/models/<id>/load?wait=0 | unload). The fleet scope's
// next poll shows the new state.
import { useState } from "react"
import { Download, LoaderCircle, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"

export function ModelLoad({ id, state, doing, off, size = "sm" }: { id: string; state?: string; doing?: string; off: boolean; size?: "xs" | "sm" }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (off || !state) return null
  const loading = state === "loading" || state === "waiting" || state === "restoring" || doing === "loading" || doing === "restoring"
  const unloading = state === "closing" || doing === "unloading" || doing === "leaving"
  const transitioning = loading || unloading
  const loaded = state === "resident"
  async function act() {
    const what = loaded ? "unload" : "load"
    const ask = loaded
      ? `Unload ${id}? Requests in progress finish first.`
      : `Load ${id}? This may shrink or unload another resident model if VRAM is tight.`
    if (!confirm(ask)) return
    setBusy(true)
    setError(null)
    try { await api(`admin/models/${encodeURIComponent(id)}/${what}${loaded ? "" : "?wait=0"}`, { method: "POST" }) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const Icon = busy || transitioning ? LoaderCircle : loaded ? Upload : Download
  const label = unloading ? "Unloading…" : loading ? "Loading…" : busy ? (loaded ? "Unloading…" : "Loading…") : loaded ? "Unload" : "Load"
  return (
    <Button variant="outline" size={size} disabled={busy || transitioning} onClick={(e) => { e.stopPropagation(); void act() }}
      title={error ?? (loaded ? "Unload it now (it loads again at the next request)" : "Load it now, before a request asks for it")}
      className={error ? "border-bad/60 text-bad" : undefined}>
      <Icon className={busy || transitioning ? "animate-spin" : undefined} />
      {label}
    </Button>
  )
}
