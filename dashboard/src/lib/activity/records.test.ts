import { describe, expect, it } from "vitest"
import { appendNew, buildStats, fromColumns, mergeLog, MIN_DECODE_TOKENS, normalize, sourceOf, toEntry, type RequestRecord } from "./records"

const rec = (o: Partial<RequestRecord>): RequestRecord => normalize(o as Record<string, unknown>)

describe("records", () => {
  it("reads the columns /history/requests sends", () => {
    const r = fromColumns({ keys: ["n", "t1", "in", "ses", "ttft"], rows: [[1, 1000, 40, "s1", null], [2, 2000, 5, null, 12.5]] })
    expect(r.map((x) => x.n)).toEqual([1, 2])
    expect(r[0].ses).toBe("s1")
    expect(r[1].ses).toBe("")
    expect(r[0].ttft).toBeNull()
    expect(r[1].ttft).toBe(12.5)
    expect(r[0].pms).toBe(-1)
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
    expect(e.resp_content_type).toBe("text/event-stream")
    expect(e.error_msg).toBe("client disconnected")
    expect(e.tokens).toEqual({ cache_tokens: 100, draft_tokens: 24, draft_acc_tokens: 8, input_tokens: 20, output_tokens: 9,
      prompt_per_second: 495, tokens_per_second: 40, prompt_ms: 40, predicted_ms: 201, preempted_ms: 3 })
    expect(e.metadata).toEqual({ session: "ses_a" })
    expect(toEntry(rec({ n: 1 }), "qwen27b").model).toBe("qwen27b")
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
    expect(s.prompt_scatter).toEqual([{ length: 100, speed: 1000, prefill_ms: 100, session: "a" }])
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

  it("keeps one copy per number when a poll repeats more records than the newest 64", () => {
    const recs = Array.from({ length: 500 }, (_, i) => rec({ n: i + 1, t1: 1000 * (i + 1) }))
    const held: RequestRecord[] = []
    appendNew(held, recs, 500)
    appendNew(held, recs, 500)
    appendNew(held, [...recs.slice(-10), rec({ n: 501 })], 500)
    expect(held.length).toBe(500)
    expect(new Set(held.map((r) => r.n)).size).toBe(500)
    expect(held[held.length - 1].n).toBe(501)
    expect(held[0].n).toBe(2)
  })

  it("merges the file and the polled tail without copies", () => {
    const base = [1, 2, 3].map((n) => rec({ n }))
    const tail = [2, 3, 4, 4, 5].map((n) => rec({ n }))
    expect(mergeLog(base, tail).map((r) => r.n)).toEqual([1, 2, 3, 4, 5])
    expect(mergeLog([], tail).map((r) => r.n)).toEqual([2, 3, 4, 5])
  })
})
