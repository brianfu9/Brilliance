// A model's figures: a row of tiles, each a figure now, and the chosen one drawn large over the
// window. A figure the model has never produced (acceptance without a drafter) has no tile.
import { useState } from "react"
import { Bars, Empty, Panel, PartBar, PartLegend, type Part } from "@/components/bits"
import { Chart, Legend, type Line } from "@/components/chart"
import type { Experts, Stats } from "@/lib/api"
import { DASH, bytesParts, fBytes, fDur, fNum, fPct, fRate, fSig, fin } from "@/lib/format"
import type { Scope, Series } from "@/lib/store"
import { useRange } from "@/lib/ui"
import { RangeToggle } from "@/components/range"
import { cn } from "@/lib/utils"
import type { Kind } from "@/lib/model-kind"

export type { Kind }
const fMs = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(2)) + " ms"
const fPc = (v: number) => fPct(v, v >= 0.9995 ? 0 : 1) + "%"
const fTps = (v: number) => (v === 0 ? "0" : fSig(v))

interface Metric {
  id: string; kinds: Kind; label: string; unit?: string; draft?: boolean; always?: boolean
  show: (s: Stats, h: Series, slots: number | undefined, noun: string) => [string, string?, string?]
  lines: Line[]; fmt: (v: number) => string
  stack?: boolean; max?: number; tight?: boolean; integer?: boolean; bytes?: boolean; join?: boolean
}
const one = (key: string, label: string): Line[] => [{ key, label, color: 1 }]
const METRICS: Metric[] = [
  { id: "decode", kinds: "chat", label: "Decode", unit: "tok/s", show: (s) => [fin(s.decode_tps) ? fTps(s.decode_tps) : DASH], lines: one("decode", "tokens a second"), fmt: fTps },
  { id: "step", kinds: "chat", label: "Step", unit: "ms",
    show: (s, h) => { const v = h.last("step"); return [fin(v) ? (v >= 100 ? v.toFixed(0) : v.toFixed(2)) : DASH, (s.step_ns_decode_best ?? 0) > 0 ? "best " + fMs(s.step_ns_decode_best! / 1e6) : ""] },
    lines: [{ key: "step", label: "step", color: 1 }, { key: "stepBest", label: "best", dash: true }], fmt: fMs, tight: true },
  { id: "prefill", kinds: "chat", label: "Prefill", unit: "tok/s", show: (_s, h) => { const v = h.last("prefillRate"); return [fin(v) ? fTps(v) : DASH] }, lines: one("prefillRate", "tokens a second"), fmt: fTps, join: true },
  { id: "reqs", kinds: "chat", always: true, label: "Requests",
    show: (s, _h, slots) => [String(s.running ?? 0), (slots ? "of " + slots + " slots" : "") + (s.waiting ? " · " + s.waiting + " waiting" : "")],
    lines: [{ key: "running", label: "running", color: 1 }, { key: "waiting", label: "waiting", color: 5 }, { key: "preempted", label: "preempted", color: 2 }], fmt: (v) => fNum(v), stack: true, integer: true },
  { id: "kv", kinds: "chat", label: "KV cache",
    show: (s) => { const [v, u] = bytesParts(s.kv_bytes_used); return [v, "of " + fBytes(s.kv_bytes_total), u] },
    lines: [{ key: "kvRead", label: "in use", color: 1 }, { key: "kvKept", label: "cached for the next turn", color: 4 }], fmt: fBytes, stack: true, bytes: true },
  { id: "hit", kinds: "chat", label: "Prefix cache hits", unit: "%", show: (s) => [fin(s.prefix_hit_rate) ? fPct(s.prefix_hit_rate) : DASH], lines: one("hit", "of prompt tokens"), fmt: fPc, max: 1 },
  { id: "accept", kinds: "chat", label: "Acceptance", unit: "%", draft: true, show: (_s, h) => [fPct(h.last("accept"))], lines: one("accept", "of drafted tokens"), fmt: fPc, max: 1 },
  { id: "tok", kinds: "chat", label: "Tokens per step", draft: true, show: (_s, h) => { const v = h.last("tokStep"); return [fin(v) ? v.toFixed(2) : DASH] }, lines: one("tokStep", "tokens"), fmt: (v) => v.toFixed(2), tight: true },
  { id: "ethru", kinds: "embed", always: true, label: "Throughput", unit: "tok/s", show: (s) => [fin(s.prefill_tps) ? fTps(s.prefill_tps) : DASH], lines: one("prefill", "tokens a second"), fmt: fTps },
  { id: "erate", kinds: "embed", always: true, label: "Inputs", unit: "/s", show: (_s, h) => { const v = h.last("reqRate"); return [fin(v) ? fTps(v) : DASH] }, lines: one("reqRate", "inputs a second"), fmt: fTps },
  { id: "estep", kinds: "embed", always: true, label: "Step", unit: "ms", show: (_s, h) => { const v = h.last("stepAny"); return [fin(v) ? v.toFixed(2) : DASH] }, lines: one("stepAny", "step"), fmt: fMs, tight: true },
  { id: "eflight", kinds: "embed", always: true, label: "Active requests", show: (s) => [String(s.in_flight ?? 0)], lines: one("flight", "in flight"), fmt: (v) => fNum(v), integer: true },
  { id: "jrun", kinds: "gen", always: true, label: "Running", show: (s) => [String(s.jobs?.running ?? 0)], lines: one("jobRun", "running"), fmt: (v) => fNum(v), integer: true },
  { id: "jdone", kinds: "gen", always: true, label: "Completed", show: (s) => [fNum(s.jobs?.done), s.jobs?.failed ? s.jobs.failed + " failed" : ""], lines: one("jobDone", "made"), fmt: (v) => fNum(v), integer: true },
  { id: "jlast", kinds: "gen", always: true, label: "Last duration", show: (s) => [s.jobs?.done ? fDur(s.jobs.last_ms / 1000) : DASH], lines: one("jobTime", "took"), fmt: (v) => fDur(v), join: true },
  { id: "jmean", kinds: "gen", always: true, label: "Mean", show: (s) => [s.jobs?.done ? fDur(s.jobs.total_ms / s.jobs.done / 1000) : DASH], lines: one("jobTime", "took"), fmt: (v) => fDur(v), join: true },
]
const TRAFFIC: Line[] = [["lkAr", "between accelerators"], ["lkUp", "host to accelerator"], ["lkDn", "accelerator to host"], ["lkSsd", "drive"], ["lkStream", "streaming"]].map(([key, label], i) => ({ key, label, color: i + 1 }))

export function Performance({ scope, kind, slots, noun }: { scope: Scope<Stats>; kind: Kind; slots?: number; noun: string }) {
  const range = useRange()
  const [chosen, setChosen] = useState<string | null>(null)
  const s = scope.live, h = scope.series
  const hasDraft = (s?.draft_positions?.length ?? 0) > 0
  const produced = (m: Metric) => m.always || m.lines.some((l) => !l.dash && (h.col(l.key) ?? []).some((v) => (v ?? 0) > 0))
  const tiles = METRICS.filter((m) => m.kinds === kind && (!m.draft || hasDraft || h.has(m.lines[0].key)) && (s ? produced(m) : !m.draft))
  const metric = tiles.find((m) => m.id === chosen) ?? tiles[0]
  if (!metric) return <Empty>No data for this model yet</Empty>
  const moved = TRAFFIC.filter((l) => (h.col(l.key) ?? []).some((v) => (v ?? 0) > 0))
  const ex = s?.experts

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-xl border bg-card">
        <div role="tablist" className="grid grid-cols-2 border-b sm:grid-cols-4 xl:grid-flow-col xl:auto-cols-fr xl:grid-cols-none">
          {tiles.map((m) => {
            const [v, det, unit] = s ? m.show(s, h, slots, noun) : [DASH]
            const on = m === metric
            return (
              <button key={m.id} role="tab" aria-selected={on} onClick={() => setChosen(m.id)}
                className={cn("relative -mb-px flex min-w-0 flex-col gap-1 border-r border-b px-4 py-3 text-left transition-colors outline-none last:border-r-0 hover:bg-accent/50 focus-visible:bg-accent/60", on && "bg-accent/40")}>
                <span className="truncate text-xs font-medium text-muted-foreground">{m.id === "jdone" && noun ? noun : m.label}</span>
                <span className="num flex items-baseline gap-1 text-xl leading-none font-semibold tracking-tight">
                  <span className="truncate">{v}</span>
                  {(unit ?? m.unit) && <span className="text-xs font-normal text-muted-foreground">{unit ?? m.unit}</span>}
                </span>
                <span className="min-h-4 truncate text-xs text-muted-foreground">{det}</span>
                {on && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />}
              </button>
            )
          })}
        </div>
        <div className="flex flex-col gap-2 p-4">
          <div className="flex flex-wrap items-center gap-2">
            {metric.lines.length > 1 && <Legend lines={metric.lines} />}
            <RangeToggle className="ml-auto" />
          </div>
          <Chart key={metric.id} data={h} version={scope.version} lines={metric.lines} range={range} fmt={metric.fmt} height={300}
            stack={metric.stack} max={metric.max} tight={metric.tight} integer={metric.integer} bytes={metric.bytes} join={metric.join} />
        </div>
      </div>

      {(moved.length > 0 || hasDraft) && (
        <div className="grid gap-4 lg:grid-cols-3">
          {moved.length > 0 && (
            <Panel title="Traffic" description="Bytes per second, by destination" className={hasDraft ? "lg:col-span-2" : "lg:col-span-3"}>
              <div className="flex flex-col gap-2">
                <Legend lines={moved} />
                <Chart data={h} version={scope.version} lines={moved} range={range} fmt={fRate} stack bytes height={190} />
              </div>
            </Panel>
          )}
          {hasDraft && s?.draft_positions && (
            <Panel title="Acceptance by position" description="Share of drafted tokens accepted, by position" className={moved.length ? "" : "lg:col-span-3"}>
              <Bars values={s.draft_positions.map((p) => p.rate || 0)} max={1} height={150}
                tip={(i, v) => `Position ${i + 1}\n${fPc(v)} accepted\n${fNum(s.draft_positions![i].reached)} reached`} labels={(i) => String(i + 1)} />
            </Panel>
          )}
        </div>
      )}
      {ex && <ExpertsPanel ex={ex} h={h} version={scope.version} range={range} />}
    </div>
  )
}

const TIER: Record<string, string> = { active: "var(--series-1)", resident: "var(--series-1)", staged: "var(--series-4)", warm: "var(--series-3)", host: "var(--series-5)", ram: "var(--series-5)" }
function ExpertsPanel({ ex, h, version, range }: { ex: Experts; h: Series; version: number; range: number }) {
  const parts: Part[] = (ex.tiers ?? []).filter((t) => t.units > 0).map((t) => ({ key: t.name, label: t.name, value: t.bytes || t.units, color: TIER[t.name.toLowerCase()] ?? "var(--idle)", text: `${fNum(t.units)} units · ${fBytes(t.bytes)}` }))
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Panel title="Experts" description={`${fNum(ex.n_units)} units by where they are`}>
        <div className="flex flex-col gap-3">
          <PartBar parts={parts} className="h-3" />
          <PartLegend parts={parts} />
          {ex.layer_units && ex.layer_resident && (
            <Bars values={ex.layer_resident} max={Math.max(...ex.layer_units, 1)} height={70}
              tip={(i, v) => `Layer ${i}\n${fNum(v)} of ${fNum(ex.layer_units![i])} on the accelerator`} />
          )}
        </div>
      </Panel>
      <Panel title="Expert hit rate" description="Share of routed experts already on the accelerator">
        <Chart data={h} version={version} lines={[{ key: "expHit", label: "hits", color: 1 }]} range={range} fmt={fPc} max={1} height={170} />
      </Panel>
      <Panel title="Expert moves" description="Units per second">
        <div className="flex flex-col gap-2">
          <Legend lines={[{ key: "expIn", label: "onto the accelerator", color: 1 }, { key: "expOut", label: "off the accelerator", color: 2 }]} />
          <Chart data={h} version={version} lines={[{ key: "expIn", label: "onto the accelerator", color: 1 }, { key: "expOut", label: "off the accelerator", color: 2 }]} range={range} fmt={(v) => fTps(v) + "/s"} stack height={150} />
        </div>
      </Panel>
    </div>
  )
}
