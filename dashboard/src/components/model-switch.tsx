// The dashboard's on/off switch for a model (local): off unloads it and keeps it from loading again
// until it is turned on (POST /admin/models/<id>/off|on; the fleet keeps the choice across
// restarts). The fleet scope's next poll shows the new state.
import { useState } from "react"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { api } from "@/lib/api"

export function ModelSwitch({ id, off, label = false }: { id: string; off: boolean; label?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function turn(on: boolean) {
    if (!on && !confirm(`Turn ${id} off? It is unloaded now and does not load again until you turn it on.`)) return
    setBusy(true)
    setError(null)
    try { await api(`admin/models/${encodeURIComponent(id)}/${on ? "on" : "off"}`, { method: "POST" }) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const tip = error ?? (off ? "Off: requests for it get 503 until it is turned on" : "On: loads when a request names it")
  return (
    <Tooltip>
      <TooltipTrigger render={
        <label className="flex items-center gap-2 text-xs text-muted-foreground" onClick={(e) => e.stopPropagation()}>
          <Switch checked={!off} disabled={busy} onCheckedChange={(v) => void turn(v)} aria-label={`${id} on`} />
          {label && <span className={error ? "text-bad" : undefined}>{busy ? (off ? "Turning on…" : "Turning off…") : off ? "Off" : "On"}</span>}
        </label>
      } />
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  )
}
