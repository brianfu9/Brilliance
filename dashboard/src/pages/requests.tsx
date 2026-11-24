// Single-model Requests tab: thin wrapper over QueuePanel + FleetActivity locked to one model.
// Fetches unpaged history (`?model=<id>&limit=0`) and same-card contention intervals.
import { useEffect, useMemo, useState } from "react"
import type { FleetModel, Stats } from "@/lib/api"
import { fetchContentionIntervals, useRequestLog, type Scope } from "@/lib/store"
import { snapshotOf } from "@/lib/activity/queue"
import { sameCardMatcher } from "@/lib/model-kind"
import { QueuePanel } from "@/components/activity/QueuePanel"
import { FleetActivity } from "@/components/activity/FleetActivity"

const EMPTY_HUE = new Map<string, string>()

export function Requests({
  id,
  scope,
  model,
  models = [],
}: {
  id: string
  scope: Scope<Stats>
  model?: FleetModel
  models?: FleetModel[]
}) {
  const { records, forbidden } = useRequestLog(id, scope)
  const [otherIntervals, setOtherIntervals] = useState<{ start: number; end: number }[]>([])

  const timeRange = useMemo(() => {
    let minT = Infinity
    let maxT = 0
    for (const r of records) {
      const start = r.dms > 0 ? r.t1 - r.dms : r.t0
      if (start > 0 && start < minT) minT = start
      if (r.t1 > maxT) maxT = r.t1
    }
    return minT < maxT ? [minT, maxT] as const : null
  }, [records])

  const modelKey = models.map((m) => `${m.id}:${(m.cards ?? []).join(",")}`).join("|")
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableModels = useMemo(() => models, [modelKey])

  useEffect(() => {
    if (forbidden || !timeRange) {
      setOtherIntervals([])
      return
    }
    let live = true
    const [tFrom, tTo] = timeRange
    const isSameCard = sameCardMatcher(id, stableModels)
    fetchContentionIntervals(tFrom, tTo).then((all) => {
      if (!live) return
      setOtherIntervals(all.filter((iv) => isSameCard(iv.fm)).map(({ start, end }) => ({ start, end })))
    })
    return () => { live = false }
  }, [id, timeRange, forbidden, stableModels])

  const snap = useMemo(() => snapshotOf(id, scope.live, scope.liveReceivedAt), [id, scope.live, scope.liveReceivedAt])

  return (
    <div className="flex flex-col gap-4">
      <QueuePanel
        snapshot={snap}
        model={model}
        stats={scope.live}
        storagePrefix="radiance-requests"
      />
      <FleetActivity
        records={records}
        total={records.length}
        hasMore={false}
        loadingMore={false}
        models={stableModels}
        hueOf={EMPTY_HUE}
        selectedModel={id}
        storagePrefix="radiance-requests"
        forbidden={forbidden}
        singleModelMode
        externalOtherIntervals={otherIntervals}
      />
    </div>
  )
}
