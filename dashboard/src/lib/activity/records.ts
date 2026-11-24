// The engine's request records (GET /history/requests and /history's `requests`, written by
// Server::record) in the shapes the llama-swap fork's Activity code takes: ActivityLogEntry for the
// table and ActivityStatsData for the stats card. buildStats is a port of the fork's server-side
// Stats and speedValues (internal/store/sqlite/activity.go): the same filters, in the same order.
import { buildHistogram } from "./histogram"
import type { ActivityLogEntry, ActivityStatsData, GenScatterPoint, PromptScatterPoint, RequestKind } from "./types"

export type { RequestKind }

/** One finished request, as History::record_keys names its members. */
export interface RequestRecord {
  n: number
  t0: number            // unix ms the request arrived
  t1: number            // unix ms it finished
  rid: string           // the response id (chatcmpl-…)
  model: string         // the name the client asked for
  fm: string            // canonical fleet model id (falls back to model)
  kind: RequestKind     // endpoint kind: chat | asr | image | video | tts | shape
  path: string
  sse: boolean
  code: number
  err: string           // "" when it completed; "client disconnected" when the client left
  src: string           // "ip:<addr>" or "xff:<addr>"
  ua: string
  cache: number
  in: number            // fresh prompt tokens
  out: number
  dn: number            // drafted
  da: number            // drafts accepted
  pms: number           // prefill ms, -1 when unknown
  dms: number           // decode ms (llama-server's predicted_ms), -1 when unknown
  prms: number          // part of dms spent preempted
  ms: number            // total ms
  pps: number           // prefill tokens/s, 0 when unknown
  tps: number           // decode tokens/s, 0 when unknown
  ttft: number | null
  audio_s: number       // audio duration in seconds (ASR), 0 otherwise
  ses: string
  pri: number
  tag: string
}

/** GET /history/requests: kept records, oldest first, as columns. */
export interface RecordColumns {
  keys: string[]
  rows: unknown[][]
  total?: number
  has_more?: boolean
  min_n?: number
}

export function fromColumns(c: RecordColumns): RequestRecord[] {
  return c.rows.map((row) => {
    const o: Record<string, unknown> = {}
    c.keys.forEach((k, i) => { o[k] = row[i] })
    return normalize(o)
  })
}

/** Composite dedup key: handles legacy per-model files whose `n` values collide across models. */
export function recordKey(r: Pick<RequestRecord, "fm" | "model" | "n">): string {
  return `${r.fm || r.model}:${r.n}`
}

const compareRecords = (a: RequestRecord, b: RequestRecord) => (a.t1 - b.t1) || (a.n - b.n)

/**
 * Adds to `held` the incoming records whose composite key (`fm:n`) it does not hold yet, then
 * keeps the last `keep` (use `Infinity` for uncapped). Returns how many new records were added.
 */
export function appendNew(held: RequestRecord[], incoming: RequestRecord[], keep: number): number {
  const have = new Set(held.map(recordKey))
  let added = 0
  for (const r of incoming) {
    const k = recordKey(r)
    if (!have.has(k)) { have.add(k); held.push(r); added++ }
  }
  if (Number.isFinite(keep) && held.length > keep) held.splice(0, held.length - keep)
  return added
}

/**
 * The full log: the file's records plus the polled tail, deduplicated by composite key `fm:n`
 * (no `r.n > last` gate so legacy colliding `n` rows from another model are never dropped)
 * and sorted oldest-first by `(t1 asc, n asc)`.
 */
export function mergeLog(base: RequestRecord[], tail: RequestRecord[]): RequestRecord[] {
  const all: RequestRecord[] = []
  const have = new Set<string>()
  for (const r of base) {
    const k = recordKey(r)
    if (!have.has(k)) { have.add(k); all.push(r) }
  }
  for (const r of tail) {
    const k = recordKey(r)
    if (!have.has(k)) { have.add(k); all.push(r) }
  }
  all.sort(compareRecords)
  return all
}

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d)
const str = (v: unknown) => (typeof v === "string" ? v : "")
const KINDS = new Set<RequestKind>(["chat", "asr", "image", "video", "tts", "shape"])
const parseKind = (v: unknown): RequestKind => (typeof v === "string" && KINDS.has(v as RequestKind) ? (v as RequestKind) : "chat")

/** A record with every member present and typed (a missing number is 0, or -1 for the times). */
export function normalize(o: Record<string, unknown>): RequestRecord {
  const model = str(o.model)
  const fm = str(o.fm) || model
  return {
    n: num(o.n), t0: num(o.t0), t1: num(o.t1), rid: str(o.rid), model, fm, kind: parseKind(o.kind), path: str(o.path),
    sse: o.sse === true, code: num(o.code), err: str(o.err), src: str(o.src), ua: str(o.ua),
    cache: num(o.cache), in: num(o.in), out: num(o.out), dn: num(o.dn), da: num(o.da),
    pms: num(o.pms, -1), dms: num(o.dms, -1), prms: num(o.prms), ms: num(o.ms),
    pps: num(o.pps), tps: num(o.tps), ttft: typeof o.ttft === "number" ? o.ttft : null,
    audio_s: num(o.audio_s),
    ses: str(o.ses), pri: num(o.pri), tag: str(o.tag),
  }
}

const LOOPBACK = /^(ip|xff):(127\.|::1$|localhost$)/

/**
 * The Source/Caller text. Behind the fleet's Windows port proxy every peer is 127.0.0.1, so a
 * loopback source also names the client's User-Agent product (opencode, curl, …).
 */
export function sourceOf(r: RequestRecord): string {
  const product = r.ua.split(/\s+/)[0] ?? ""
  return LOOPBACK.test(r.src) && product ? `${r.src} ${product}` : r.src || "-"
}

export function toEntry(r: RequestRecord, fallbackModel: string): ActivityLogEntry {
  const metadata: Record<string, string> = {}
  if (r.ses) metadata.session = r.ses
  if (r.tag) metadata.tag = r.tag
  if (r.ttft !== null) metadata.ttft_ms = String(Math.round(r.ttft))
  if (r.rid) metadata.request_id = r.rid
  if (r.ua) metadata.user_agent = r.ua
  if (r.audio_s > 0) metadata.audio_s = `${r.audio_s.toFixed(1)}s`
  return {
    id: r.n,
    timestamp: new Date(r.t1).toISOString(),
    src: sourceOf(r),
    model: r.model || fallbackModel,
    fleetModel: r.fm || fallbackModel,
    kind: r.kind,
    audio_s: r.audio_s,
    req_path: r.path,
    resp_content_type: r.sse ? "text/event-stream" : "application/json",
    resp_status_code: r.code,
    tokens: {
      cache_tokens: r.cache, draft_tokens: r.dn, draft_acc_tokens: r.da,
      input_tokens: r.in, output_tokens: r.out,
      prompt_per_second: r.pps, tokens_per_second: r.tps,
      prompt_ms: Math.round(r.pms), predicted_ms: Math.round(r.dms), preempted_ms: Math.round(r.prms),
    },
    duration_ms: Math.round(r.ms),
    has_capture: false,
    error_msg: r.err || undefined,
    metadata,
  }
}

/**
 * Output tokens a request needs before its decode speed goes into the decode charts. A short answer
 * decodes in one or two steps, so one speculative step that accepts the whole draft sets its speed
 * (8 tokens in 9 ms read as 770 tok/s); its totals and its table row stay.
 */
export const MIN_DECODE_TOKENS = 16
export const ASR_MIN_DECODE_TOKENS = 4
export const ASR_MIN_DECODE_MS = 50

function medianValue(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** The fork's Stats over records (oldest first): totals, histograms, duration/RTF stats and scatter points. */
export function buildStats(records: RequestRecord[], kind?: RequestKind): ActivityStatsData {
  let input = 0, output = 0, cache = 0
  let failed = 0, aborted = 0
  let totalDurationMs = 0, totalAudioS = 0
  const prompt: number[] = [], gen: number[] = []
  const promptScatter: PromptScatterPoint[] = [], genScatter: GenScatterPoint[] = []
  const durationsMs: number[] = [], durationsSec: number[] = [], rtfs: number[] = []
  const effectiveKind: RequestKind = kind ?? "chat"

  for (const r of records) {
    input += r.in
    output += r.out
    if (r.cache > 0) cache += r.cache
    const isAborted = r.err.startsWith("client disconnected")
    if (isAborted) aborted++
    else if (r.code >= 400 || r.err !== "") failed++

    if (r.ms > 0) {
      durationsMs.push(r.ms)
      durationsSec.push(r.ms / 1000)
      totalDurationMs += r.ms
    }
    if (r.audio_s > 0) {
      totalAudioS += r.audio_s
      if (r.ms > 0) rtfs.push(r.audio_s / (r.ms / 1000))
    }

    if (!(r.pps > 0 || r.tps > 0)) continue
    if (r.pps > 0) {
      prompt.push(r.pps)
      if (r.in > 0) promptScatter.push({ length: r.in, context: r.in + Math.max(0, r.cache), speed: r.pps, prefill_ms: Math.round(r.pms), session: r.ses })
    }
    const decodeOk = effectiveKind === "asr"
      ? (r.tps > 0 && r.out >= ASR_MIN_DECODE_TOKENS && r.dms >= ASR_MIN_DECODE_MS)
      : (r.tps > 0 && r.out >= MIN_DECODE_TOKENS)
    if (decodeOk) {
      gen.push(r.tps)
      const context = r.in + r.cache
      if (context > 0) {
        genScatter.push({
          context, speed: r.tps, accept: r.dn > 0 ? r.da / r.dn : -1, output: r.out, session: r.ses,
          end_ms: r.t1, decode_ms: Math.round(r.dms), preempted_ms: Math.round(r.prms),
        })
      }
    }
  }
  return {
    total_requests: records.length,
    total_input_tokens: input,
    total_output_tokens: output,
    total_cache_tokens: cache,
    prompt_histogram: buildHistogram(prompt),
    gen_histogram: buildHistogram(gen),
    prompt_scatter: promptScatter,
    gen_scatter: genScatter,
    duration_histogram: buildHistogram(durationsSec),
    rtf_histogram: rtfs.length >= 2 ? buildHistogram(rtfs) : null,
    failed_requests: failed,
    aborted_requests: aborted,
    median_duration_ms: durationsMs.length > 0 ? medianValue(durationsMs) : 0,
    mean_duration_ms: durationsMs.length > 0 ? totalDurationMs / durationsMs.length : 0,
    total_duration_ms: totalDurationMs,
    total_audio_s: totalAudioS,
    median_rtf: rtfs.length > 0 ? medianValue(rtfs) : 0,
  }
}
