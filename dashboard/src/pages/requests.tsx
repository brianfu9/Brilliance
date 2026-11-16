// A model's requests, as the llama-swap fork's Activity page showed them: the stats card (histograms
// and heat maps over every kept request), the queue (live), and the table of finished requests.
// The records come from the engine (Server::record), kept across restarts (History).
import { Kpi, Empty, Panel } from "@/components/bits"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { Stats } from "@/lib/api"
import { DASH, fDur, fNum, fSig, fin } from "@/lib/format"
import { useRequestLog, type Scope } from "@/lib/store"
import { useMemo } from "react"
import { ActivityStats } from "@/components/activity/ActivityStats"
import { buildStats, toEntry } from "@/lib/activity/records"
import { ActivityTable } from "@/components/activity/ActivityTable"
import { Button } from "@/components/ui/button"
import { Download } from "lucide-react"

const median = (a: number[]) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1] }

export function Requests({ id, scope }: { id: string; scope: Scope<Stats> }) {
  const s = scope.live
  const { records } = useRequestLog(id, scope)
  const speeds = records.map((r) => r.tps).filter((v) => v > 0)
  const ttfts = records.map((r) => r.ttft).filter((v): v is number => v !== null).map((v) => v / 1000)
  const stats = useMemo(() => buildStats(records), [records])
  const entries = useMemo(() => records.map((r) => toEntry(r, id)), [records, id])

  function save() {
    const blob = new Blob([JSON.stringify(records, null, 1)], { type: "application/json" })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = `${id}-requests.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  const mean = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : null

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Served" value={fNum(s?.total_requests)} detail="since the model started" />
        <Kpi label="Preempted" value={fNum(s?.preemptions)} detail="requests paused for another and resumed" />
        <Kpi label="Mean speed" value={fin(mean) ? fSig(mean) : DASH} unit="tok/s" detail={`over ${fNum(speeds.length)} kept`} />
        <Kpi label="Median time to first token" value={ttfts.length ? fDur(median(ttfts)) : DASH} detail={`over ${fNum(ttfts.length)} kept`} />
      </div>
      <ActivityStats stats={stats} />
      <Panel title="Time to first token" description="Distribution across the kept requests">
        <Histogram values={ttfts} />
      </Panel>
      <ActivityTable metrics={entries} storagePrefix="radiance-requests" title="Finished requests" emptyMessage="No finished requests kept yet" />
      <div className="-mt-2 flex justify-end">
        <Button variant="outline" size="sm" onClick={save} disabled={!records.length}><Download />Export JSON</Button>
      </div>
    </div>
  )
}

function Histogram({ values }: { values: number[] }) {
  if (values.length < 2) return <Empty>Available after two finished requests</Empty>
  const edges = [0, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, Infinity]
  const used = edges.findIndex((e) => e > Math.max(...values))
  const bins = edges.slice(0, Math.max(6, used + 1))
  const counts = bins.slice(0, -1).map((lo, i) => values.filter((v) => v >= lo && v < bins[i + 1]).length)
  const top = Math.max(...counts, 1)
  const name = (i: number) => (bins[i + 1] === Infinity ? "over " + fDur(bins[i]) : "under " + fDur(bins[i + 1]))
  return (
    <div className="flex h-[12.25rem] flex-col justify-end gap-1.5">
      <div className="flex flex-1 items-end justify-center gap-1.5">
        {counts.map((c, i) => (
          <Tooltip key={i}>
            <TooltipTrigger render={<div className="flex h-full max-w-24 flex-1 flex-col justify-end"><span className="num mb-1 text-center text-[11px] text-muted-foreground">{c || ""}</span><div className="rounded-sm bg-primary/80" style={{ height: Math.max(c ? 3 : 0, (82 * c) / top) + "%" }} /></div>} />
            <TooltipContent>{c} {c === 1 ? "request" : "requests"} {name(i)}</TooltipContent>
          </Tooltip>
        ))}
      </div>
      <div className="num flex justify-center gap-1.5 border-t pt-1 text-[11px] text-muted-foreground">
        {counts.map((_, i) => <span key={i} className="max-w-24 flex-1 truncate text-center">{bins[i + 1] === Infinity ? "> " + fDur(bins[i]) : "< " + fDur(bins[i + 1])}</span>)}
      </div>
    </div>
  )
}
