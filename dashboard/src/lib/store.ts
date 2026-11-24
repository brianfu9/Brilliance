// The page's copy of what the process remembers. One Scope per subject (the fleet, or a model):
// it loads the server's hour once, then asks five times a second for what came after its last sample and
// appends it. Views read a scope through useScope and redraw when its version moves.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { HttpError, api, withModel, type Fleet, type HistoryBody, type Stats } from "./api"
import { appendNew, fromColumns, mergeLog, normalize, type RecordColumns, type RequestRecord } from "./activity/records"

const KEEP_S = 3600
// The server samples five times a second while a page asks (once a second otherwise), so each
// answer carries the rows since the last one and the live object.
const POLL_MS = 200
const FLEET_PAGE_LIMIT = 5000

export class Series {
  t: number[] = []
  c = new Map<string, (number | null)[]>()

  append(t: number[], cols: Record<string, (number | null)[]>) {
    // Only what is later than everything held: a sample the server sent before is not kept twice.
    let from = 0
    while (from < t.length && t[from] <= this.end) ++from
    if (from === t.length) return
    const n0 = this.t.length
    for (let i = from; i < t.length; ++i) this.t.push(t[i])
    const n = this.t.length
    for (const [k, a] of Object.entries(cols)) {
      let col = this.c.get(k)
      if (!col) { col = new Array(n0).fill(null); this.c.set(k, col) }
      for (let i = from; i < a.length; ++i) col.push(a[i])
    }
    for (const col of this.c.values()) while (col.length < n) col.push(null)
    const cut = this.firstAfter(this.t[n - 1] - KEEP_S)
    if (cut > 64) { this.t.splice(0, cut); for (const col of this.c.values()) col.splice(0, cut) }
  }
  /** The first index whose time is later than `t`. */
  firstAfter(t: number): number {
    let lo = 0, hi = this.t.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.t[m] <= t) lo = m + 1; else hi = m }
    return lo
  }
  col(k: string): (number | null)[] | undefined { return this.c.get(k) }
  has(k: string): boolean { const a = this.c.get(k); return !!a && a.some((v) => v !== null) }
  /** The latest value of a column among the last `within` samples (five minutes of them). */
  last(k: string, within = 300): number | null {
    const a = this.c.get(k)
    if (a) for (let i = a.length - 1; i >= 0 && i >= a.length - within; --i) if (a[i] !== null) return a[i]
    return null
  }
  get end(): number { return this.t.length ? this.t[this.t.length - 1] : 0 }
}

type Listener = () => void

export class Scope<Live> {
  series = new Series()
  live: Live | null = null
  /** performance.now() when `live` was received (keeps render pure for QueuePanel age ticks). */
  liveReceivedAt = 0
  finished: RequestRecord[] = []
  modelStats: Record<string, Stats> = {}
  /** performance.now() when each model's `modelStats[id]` last advanced `now_ms`. */
  modelStatsReceivedAt: Record<string, number> = {}
  oldestN = 0
  maxN = 0
  /** Increments ONLY when `finished` actually gains a new record (not on every 200ms poll). */
  logVersion = 0
  loaded = false
  error: string | null = null
  /** True once the server said this subject is not for this client (403): asking again is pointless. */
  refused = false
  version = 0
  private path: string
  private subs = new Set<Listener>()
  private timer: number | undefined
  private busy = false
  private pendingPoll = false
  private users = 0
  private activityUsers = 0

  constructor(path: string) { this.path = path }

  subscribe = (f: Listener) => {
    this.subs.add(f)
    if (++this.users === 1) this.start()
    return () => { this.subs.delete(f); if (--this.users === 0) this.stop() }
  }
  getVersion = () => this.version

  /** Ref-counted opt-in so `?activity=1&after_n=...` is sent only while Overview is mounted. */
  acquireActivity() {
    if (++this.activityUsers === 1 && this.users > 0) {
      if (this.busy) this.pendingPoll = true
      else void this.poll()
    }
  }
  releaseActivity() {
    if (this.activityUsers > 0) --this.activityUsers
  }

  /** Inform the scope of the highest `n` already fetched from `/history/requests` to avoid resending. */
  seedMaxN(n: number) {
    if (n > this.maxN) this.maxN = n
  }

  private start() {
    void this.poll()
    this.timer = window.setInterval(() => { if (!document.hidden) void this.poll() }, POLL_MS)
    document.addEventListener("visibilitychange", this.onVisible)
  }
  private stop() {
    window.clearInterval(this.timer)
    document.removeEventListener("visibilitychange", this.onVisible)
  }
  private onVisible = () => { if (!document.hidden) void this.poll() }

  private async poll() {
    if (this.busy || this.refused) return
    this.busy = true
    try {
      const params: string[] = []
      const since = this.series.end
      if (since) params.push("since=" + since)
      if (this.activityUsers > 0) {
        params.push("activity=1")
        if (this.maxN > 0) params.push("after_n=" + this.maxN)
      }
      const sep = this.path.includes("?") ? "&" : "?"
      const url = params.length ? this.path + sep + params.join("&") : this.path
      const b = await api<HistoryBody<Live>>(url)
      this.series.append(b.t, b.c)
      if (b.requests?.length) {
        const incoming = b.requests.map(normalize)
        const keep = this.activityUsers > 0 ? Infinity : 500
        const added = appendNew(this.finished, incoming, keep)
        for (const r of incoming) if (r.n > this.maxN) this.maxN = r.n
        if (added > 0) ++this.logVersion
      }
      if (typeof b.oldest_n === "number") this.oldestN = b.oldest_n
      const recv = typeof performance !== "undefined" ? performance.now() : Date.now()
      if (b.model_stats) {
        const nextStamps: Record<string, number> = {}
        for (const [id, st] of Object.entries(b.model_stats)) {
          const prev = this.modelStats[id]
          nextStamps[id] = prev && prev.now_ms === st.now_ms
            ? (this.modelStatsReceivedAt[id] ?? recv)
            : recv
        }
        this.modelStats = b.model_stats
        this.modelStatsReceivedAt = nextStamps
      }
      this.live = b.live
      this.liveReceivedAt = recv
      this.loaded = true
      this.error = null
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      if (e instanceof HttpError && e.status === 403) this.refused = true
    } finally {
      this.busy = false
      ++this.version
      this.subs.forEach((f) => f())
      if (this.pendingPoll) {
        this.pendingPoll = false
        if (this.users > 0) void this.poll()
      }
    }
  }
}

export const fleet = new Scope<Fleet>("history")
const models = new Map<string, Scope<Stats>>()
export function modelScope(id: string): Scope<Stats> {
  let s = models.get(id)
  if (!s) { s = new Scope<Stats>(withModel("history", id)); models.set(id, s) }
  return s
}

/** Subscribes the component to a scope; the scope polls while anything is subscribed. */
export function useScope<L>(s: Scope<L>): Scope<L> {
  useSyncExternalStore(s.subscribe, s.getVersion)
  return s
}

function minSeqOf(rows: RequestRecord[]): number {
  let m = 0
  for (const r of rows) if (r.n > 0 && (m === 0 || r.n < m)) m = r.n
  return m
}

function maxSeqOf(rows: RequestRecord[]): number {
  let m = 0
  for (const r of rows) if (r.n > m) m = r.n
  return m
}

export interface FleetRequestLog {
  records: RequestRecord[]
  total: number
  hasMore: boolean
  loadingMore: boolean
  loadOlder: () => void
  loaded: boolean
  error: string | null
  forbidden: boolean
  maxN: number
}

/**
 * Multi-model request log for Overview: loads the newest page (`limit=5000`) from `/history/requests`,
 * merges live records arriving via `/history?activity=1&after_n=K`, recovers any ring-eviction gap
 * automatically via `after_n`, and supports paging backwards with `loadOlder()`.
 */
export function useFleetRequestLog(scope: Scope<Fleet>): FleetRequestLog {
  const [base, setBase] = useState<RequestRecord[] | null>(null)
  const [serverTotal, setServerTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [minN, setMinN] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const catchupRef = useRef(0)

  useEffect(() => {
    let live = true
    api<RecordColumns>(`history/requests?limit=${FLEET_PAGE_LIMIT}`)
      .then((c) => {
        if (!live) return
        const rows = fromColumns(c)
        setBase(rows)
        setServerTotal(typeof c.total === "number" ? c.total : rows.length)
        setHasMore(c.has_more === true)
        const min = typeof c.min_n === "number" && c.min_n > 0 ? c.min_n : minSeqOf(rows)
        setMinN(min)
        const hi = maxSeqOf(rows)
        if (hi > 0) scope.seedMaxN(hi)
      })
      .catch((e) => {
        if (!live) return
        if (e instanceof HttpError && e.status === 403) setForbidden(true)
        setError(e instanceof Error ? e.message : String(e))
      })
    return () => { live = false }
  }, [scope])

  const logVersion = scope.logVersion
  const records = useMemo(() => {
    if (forbidden) return []
    return mergeLog(base ?? [], scope.finished)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, logVersion, forbidden])

  const maxN = useMemo(() => maxSeqOf(records), [records])

  // Detect ring gap (e.g. tab hidden while >500 records arrived) and catch up via /history/requests?after_n=
  const oldestN = scope.oldestN
  useEffect(() => {
    if (forbidden || base === null) return
    const lastKnown = maxN
    if (oldestN > 0 && lastKnown > 0 && lastKnown < oldestN - 1 && catchupRef.current < oldestN) {
      catchupRef.current = oldestN
      let live = true
      api<RecordColumns>(`history/requests?after_n=${lastKnown}&limit=0`)
        .then((c) => {
          if (!live) return
          const gap = fromColumns(c)
          if (gap.length) {
            setBase((prev) => mergeLog(prev ?? [], gap))
            const hi = maxSeqOf(gap)
            if (hi > 0) scope.seedMaxN(hi)
          }
          if (typeof c.total === "number") setServerTotal(c.total)
        })
        .catch(() => { /* best effort; next poll can retry if needed */ })
      return () => { live = false }
    }
  }, [oldestN, maxN, base, forbidden, scope])

  const loadOlder = useCallback(() => {
    if (loadingMore || !hasMore || minN <= 0 || forbidden) return
    setLoadingMore(true)
    api<RecordColumns>(`history/requests?limit=${FLEET_PAGE_LIMIT}&before_n=${minN}`)
      .then((c) => {
        const older = fromColumns(c)
        setBase((prev) => mergeLog(older, prev ?? []))
        setHasMore(c.has_more === true)
        if (typeof c.total === "number") setServerTotal(c.total)
        const nextMin = typeof c.min_n === "number" && c.min_n > 0 ? c.min_n : minSeqOf(older)
        if (nextMin > 0) setMinN(nextMin)
      })
      .catch((e) => {
        if (e instanceof HttpError && e.status === 403) setForbidden(true)
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => { setLoadingMore(false) })
  }, [loadingMore, hasMore, minN, forbidden])

  const baseCount = base?.length ?? 0
  const extraLive = Math.max(0, records.length - baseCount)
  const total = forbidden ? 0 : Math.max(records.length, serverTotal + extraLive)

  return {
    records,
    total,
    hasMore: forbidden ? false : hasMore,
    loadingMore,
    loadOlder,
    loaded: base !== null || error !== null,
    error,
    forbidden,
    maxN,
  }
}

/**
 * Every kept request of a single model: GET /history/requests?model=<id>&limit=0 once (unpaged),
 * then the ones the scope's /history poll brings. Returns empty records with `forbidden: true` on 403.
 */
export function useRequestLog(
  id: string,
  scope: Scope<Stats>,
): { records: RequestRecord[]; loaded: boolean; error: string | null; forbidden: boolean } {
  const [base, setBase] = useState<RequestRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  useEffect(() => {
    let live = true
    setBase(null)
    setError(null)
    setForbidden(false)
    api<RecordColumns>(withModel("history/requests", id) + "&limit=0")
      .then((c) => { if (live) setBase(fromColumns(c)) })
      .catch((e) => {
        if (!live) return
        if (e instanceof HttpError && e.status === 403) setForbidden(true)
        setError(e instanceof Error ? e.message : String(e))
      })
    return () => { live = false }
  }, [id])
  const logVersion = scope.logVersion
  const records = useMemo(() => {
    if (forbidden) return []
    return mergeLog(base ?? [], scope.finished)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, logVersion, forbidden])
  return { records, loaded: base !== null || error !== null, error, forbidden }
}

/**
 * Fetches slim timing intervals across all models in `[tFrom, tTo]` for cross-model contention
 * exclusion on the per-model Requests tab. Silently returns `[]` on 403 or any fetch error.
 */
export async function fetchContentionIntervals(
  tFrom: number,
  tTo: number,
): Promise<{ start: number; end: number; fm: string }[]> {
  if (!Number.isFinite(tFrom) || !Number.isFinite(tTo) || tTo <= tFrom) return []
  try {
    const c = await api<RecordColumns>(
      `history/requests?t_from=${Math.floor(tFrom)}&t_to=${Math.ceil(tTo)}&fields=t0,t1,dms,fm&limit=0`,
    )
    const rows = fromColumns(c)
    const out: { start: number; end: number; fm: string }[] = []
    for (const r of rows) {
      const end = r.t1
      const start = r.dms > 0 ? end - r.dms : r.t0
      if (end > start && start > 0) {
        out.push({ start, end, fm: r.fm || r.model })
      }
    }
    return out
  } catch {
    return []
  }
}
