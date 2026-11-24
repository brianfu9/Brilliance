import { describe, expect, it } from "vitest"
import {
  appendNew,
  ASR_MIN_DECODE_MS,
  ASR_MIN_DECODE_TOKENS,
  buildStats,
  fromColumns,
  mergeLog,
  MIN_DECODE_TOKENS,
  normalize,
  recordKey,
  sourceOf,
  toEntry,
  type RequestRecord,
} from "./records"

const rec = (o: Partial<RequestRecord>): RequestRecord => normalize(o as Record<string, unknown>)

describe("records", () => {
  it("reads the columns /history/requests sends", () => {
    const r = fromColumns({
      keys: ["n", "t1", "in", "ses", "ttft", "fm", "kind", "audio_s"],
      rows: [
        [1, 1000, 40, "s1", null, "qwen27b", "chat", 0],
        [2, 2000, 5, null, 12.5, "qwen3-asr", "asr", 4.2],
      ],
    })
    expect(r.map((x) => x.n)).toEqual([1, 2])
    expect(r[0].ses).toBe("s1")
    expect(r[1].ses).toBe("")
    expect(r[0].ttft).toBeNull()
    expect(r[1].ttft).toBe(12.5)
    expect(r[0].pms).toBe(-1)
    expect(r[0].fm).toBe("qwen27b")
    expect(r[0].kind).toBe("chat")
    expect(r[1].fm).toBe("qwen3-asr")
    expect(r[1].kind).toBe("asr")
    expect(r[1].audio_s).toBe(4.2)
  })

  it("defaults missing fm to model and missing/unknown kind to chat", () => {
    const r = normalize({ n: 1, model: "rad", kind: "unknown" })
    expect(r.fm).toBe("rad")
    expect(r.kind).toBe("chat")
    expect(r.audio_s).toBe(0)
  })

  it("names the client behind the port proxy by its User-Agent", () => {
    expect(sourceOf(rec({ src: "ip:127.0.0.1", ua: "opencode/1.2 (linux)" }))).toBe("ip:127.0.0.1 opencode/1.2")
    expect(sourceOf(rec({ src: "ip:100.64.0.7", ua: "curl/8" }))).toBe("ip:100.64.0.7")
    expect(sourceOf(rec({ src: "ip:127.0.0.1" }))).toBe("ip:127.0.0.1")
  })

  it("maps a record to the fork's ActivityLogEntry", () => {
    const e = toEntry(rec({ n: 7, t1: 1794590851000, model: "rad", path: "/v1/chat/completions", sse: true, code: 200,
      err: "client disconnected", cache: 100, in: 20, out: 9, dn: 24, da: 8, pms: 40.4, dms: 200.6, prms: 3, ms: 260,
      pps: 495, tps: 40, ses: "ses_a", pri: 2 }), "qwen27b")
    expect(e.id).toBe(7)
    expect(e.model).toBe("rad")
    expect(e.fleetModel).toBe("rad")
    expect(e.kind).toBe("chat")
    expect(e.resp_content_type).toBe("text/event-stream")
    expect(e.error_msg).toBe("client disconnected")
    expect(e.tokens).toEqual({ cache_tokens: 100, draft_tokens: 24, draft_acc_tokens: 8, input_tokens: 20, output_tokens: 9,
      prompt_per_second: 495, tokens_per_second: 40, prompt_ms: 40, predicted_ms: 201, preempted_ms: 3 })
    expect(e.metadata).toEqual({ session: "ses_a" })
    expect(toEntry(rec({ n: 1 }), "qwen27b").model).toBe("qwen27b")
    expect(toEntry(rec({ n: 2, fm: "qwen3-asr", kind: "asr", audio_s: 4.24 }), "qwen3-asr").metadata).toEqual({ audio_s: "4.2s" })
  })

  it("builds the fork's stats: totals over all, speeds only where reported", () => {
    const s = buildStats([
      rec({ in: 100, cache: 900, out: 50, pps: 1000, tps: 60, dn: 30, da: 15, t1: 5, dms: 800, ses: "a", pms: 100 }),
      rec({ in: 0, cache: 40, out: 20, pps: 0, tps: 55 }),          // no fresh prompt: decode point only
      rec({ in: 10, out: 0, pps: 0, tps: 0 }),                       // no speeds: totals only
    ])
    expect(s.total_requests).toBe(3)
    expect(s.total_input_tokens).toBe(110)
    expect(s.total_output_tokens).toBe(70)
    expect(s.total_cache_tokens).toBe(940)
    expect(s.prompt_scatter).toEqual([{ length: 100, context: 1000, speed: 1000, prefill_ms: 100, session: "a" }])
    expect(s.gen_scatter.map((p) => p.context)).toEqual([1000, 40])
    expect(s.gen_scatter[0].accept).toBe(0.5)
    expect(s.gen_scatter[1].accept).toBe(-1)
    expect(s.gen_scatter[0].end_ms).toBe(5)
    expect(s.gen_histogram?.bins.reduce((a, b) => a + b, 0)).toBe(2)
    expect(s.prompt_histogram?.bins.reduce((a, b) => a + b, 0)).toBe(1)
  })

  it("keeps a short answer's decode speed out of the decode charts, not out of the totals", () => {
    // Seen 2026-11-17: 8 tokens in one 9 ms speculative step plotted at 770 tok/s.
    const s = buildStats([
      rec({ in: 16405, out: 8, pps: 2350, tps: 770, pms: 6983, dms: 9 }),
      rec({ in: 2000, out: MIN_DECODE_TOKENS, pps: 1500, tps: 80, dms: 200 }),
    ])
    expect(s.total_output_tokens).toBe(8 + MIN_DECODE_TOKENS)
    expect(s.gen_scatter.map((p) => p.speed)).toEqual([80])
    expect(s.gen_histogram?.bins.reduce((a, b) => a + b, 0)).toBe(1)
    expect(s.prompt_scatter).toHaveLength(2)
  })

  it("uses ASR decode thresholds and computes audio_s and RTF stats", () => {
    const s = buildStats([
      // Under ASR token threshold -> excluded from decode charts
      rec({ kind: "asr", in: 50, out: ASR_MIN_DECODE_TOKENS - 1, tps: 120, dms: 100, ms: 500, audio_s: 5 }),
      // Under ASR dms threshold -> excluded from decode charts
      rec({ kind: "asr", in: 50, out: 10, tps: 250, dms: ASR_MIN_DECODE_MS - 1, ms: 200, audio_s: 4 }),
      // Valid ASR decode (out >= 4 && dms >= 50) -> included even though out < 16
      rec({ kind: "asr", in: 80, out: 8, tps: 90, dms: 88, ms: 400, audio_s: 8 }),
      rec({ kind: "asr", in: 100, out: 12, tps: 110, dms: 110, ms: 500, audio_s: 15 }),
    ], "asr")
    expect(s.gen_scatter.map((p) => p.speed)).toEqual([90, 110])
    expect(s.total_audio_s).toBeCloseTo(32, 6)
    // RTFs: 5/0.5=10, 4/0.2=20, 8/0.4=20, 15/0.5=30 -> median = 20
    expect(s.median_rtf).toBeCloseTo(20, 6)
    expect(s.rtf_histogram).not.toBeNull()
    expect(s.rtf_histogram?.bins.reduce((a, b) => a + b, 0)).toBe(4)
  })

  it("computes duration histogram and failed/aborted counts for media requests", () => {
    const s = buildStats([
      rec({ kind: "image", code: 200, ms: 4000 }),
      rec({ kind: "image", code: 200, ms: 6000 }),
      rec({ kind: "image", code: 500, err: "oom", ms: 1000 }),
      rec({ kind: "image", code: 200, err: "client disconnected", ms: 2000 }),
    ], "image")
    expect(s.total_requests).toBe(4)
    expect(s.failed_requests).toBe(1)
    expect(s.aborted_requests).toBe(1)
    expect(s.total_duration_ms).toBe(13000)
    expect(s.mean_duration_ms).toBe(3250)
    expect(s.median_duration_ms).toBe(3000)
    expect(s.duration_histogram).not.toBeNull()
    expect(s.duration_histogram?.min).toBe(1)
    expect(s.duration_histogram?.max).toBe(6)
  })

  it("keeps one copy per composite key when a poll repeats records and supports keep = Infinity", () => {
    const recs = Array.from({ length: 500 }, (_, i) => rec({ n: i + 1, t1: 1000 * (i + 1), fm: "qwen27b" }))
    const held: RequestRecord[] = []
    expect(appendNew(held, recs, 500)).toBe(500)
    expect(appendNew(held, recs, 500)).toBe(0)
    expect(appendNew(held, [...recs.slice(-10), rec({ n: 501, fm: "qwen27b" })], 500)).toBe(1)
    expect(held.length).toBe(500)
    expect(new Set(held.map(recordKey)).size).toBe(500)
    expect(held[held.length - 1].n).toBe(501)
    expect(held[0].n).toBe(2)

    // Uncapped keep = Infinity keeps more than 500 and distinguishes colliding `n` across models
    const uncapped: RequestRecord[] = []
    appendNew(uncapped, recs, Infinity)
    appendNew(uncapped, [rec({ n: 1, t1: 1500, fm: "qwen3-asr" }), rec({ n: 2, t1: 2500, fm: "qwen3-asr" })], Infinity)
    expect(uncapped.length).toBe(502)
  })

  it("merges multi-model logs by composite fm:n key without dropping colliding legacy n rows and sorts by (t1, n)", () => {
    const base = [
      rec({ n: 1, t1: 1000, fm: "qwen27b" }),
      rec({ n: 2, t1: 3000, fm: "qwen27b" }),
      rec({ n: 3, t1: 5000, fm: "qwen27b" }),
    ]
    // Legacy collision: another model has n=1, n=2 with t1 interleaved, plus duplicate qwen27b:3 and new qwen27b:4
    const tail = [
      rec({ n: 1, t1: 2000, fm: "qwen3-asr" }),
      rec({ n: 2, t1: 4000, fm: "qwen3-asr" }),
      rec({ n: 3, t1: 5000, fm: "qwen27b" }),
      rec({ n: 4, t1: 6000, fm: "qwen27b" }),
    ]
    const merged = mergeLog(base, tail)
    expect(merged.map((r) => `${r.fm}:${r.n}`)).toEqual([
      "qwen27b:1",
      "qwen3-asr:1",
      "qwen27b:2",
      "qwen3-asr:2",
      "qwen27b:3",
      "qwen27b:4",
    ])
    expect(mergeLog([], [2, 3, 4, 4, 5].map((n) => rec({ n }))).map((r) => r.n)).toEqual([2, 3, 4, 5])
  })
})
