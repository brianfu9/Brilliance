// A model's requests, as the llama-swap fork's Activity page showed them: the stats card (histograms
// and heat maps over every kept request), the queue (live), and the table of finished requests.
// The records come from the engine (Server::record), kept across restarts (History).
import { Kpi } from "@/components/bits"
import type { Stats } from "@/lib/api"
import { DASH, fDur, fNum, fSig, fin } from "@/lib/format"
import { useRequestLog, type Scope } from "@/lib/store"
import { useMemo } from "react"
import { ActivityStats } from "@/components/activity/ActivityStats"
import { buildStats, toEntry } from "@/lib/activity/records"
import { ActivityTable } from "@/components/activity/ActivityTable"
import { QueuePanel } from "@/components/activity/QueuePanel"
import { snapshotOf } from "@/lib/activity/queue"
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
      <QueuePanel snapshot={snapshotOf(id, s, Date.now())} storagePrefix="radiance-requests" />
      <ActivityTable metrics={entries} storagePrefix="radiance-requests" title="Finished requests" emptyMessage="No finished requests kept yet" />
      <div className="-mt-2 flex justify-end">
        <Button variant="outline" size="sm" onClick={save} disabled={!records.length}><Download />Export JSON</Button>
      </div>
    </div>
  )
}
