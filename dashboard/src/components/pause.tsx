// Pause every model (local; POST /admin/pause?minutes=, /admin/resume): the models leave the GPU and
// host RAM and come back at the end, while the process, this page and its history stay up. A model
// turned off by hand stays off after a resume.
import { useState } from "react"
import { Pause, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { api } from "@/lib/api"
import { fClock } from "@/lib/format"

const CHOICES: [number | null, string][] = [[15, "15 minutes"], [30, "30 minutes"], [60, "1 hour"], [120, "2 hours"], [null, "Until resumed"]]

async function post(path: string, set: (e: string | null) => void) {
  set(null)
  try { await api(path, { method: "POST" }) } catch (e) { set(e instanceof Error ? e.message : String(e)) }
}

/** The header's menu: pause for a while, or resume. */
export function PauseMenu({ paused }: { paused: boolean }) {
  const [error, setError] = useState<string | null>(null)
  if (paused)
    return <Button variant="outline" size="sm" title={error ?? "Turn the paused models back on"} onClick={() => void post("admin/resume", setError)}><Play />Resume</Button>
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs hover:bg-muted" title={error ?? "Pause every model"}>
        <Pause className="size-3.5" />Pause
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuLabel>Pause every model</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {CHOICES.map(([m, label]) => (
          <DropdownMenuItem key={label} onClick={() => void post(m ? `admin/pause?minutes=${m}` : "admin/pause", setError)}>{label}</DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Shown under the header while the fleet is paused. */
export function PauseBanner({ until }: { until: number | null }) {
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-warn/10 px-4 py-2 text-sm md:px-6">
      <Pause className="size-4 text-warn" />
      <span>Paused{until ? ` until ${fClock(until)}` : " until resumed"}: every model is off, requests get 503. This page and its history stay up.</span>
      <Button variant="outline" size="sm" className="ml-auto" onClick={() => void post("admin/resume", setError)}><Play />Resume now</Button>
      {error && <span className="w-full text-xs text-bad">{error}</span>}
    </div>
  )
}
