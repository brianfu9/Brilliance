import { describe, expect, it } from "vitest"
import type { Stats } from "@/lib/api"
import { snapshotOf } from "./queue"
import { kvLayout } from "./queueView"

describe("snapshotOf", () => {
  it("maps /stats to the fork's QueueSnapshot and drops finished rows", () => {
    const s = {
      model: "qwen27b", uptime_s: 1, in_flight: 2, now_ms: 5000, max_num_seqs: 8, jobs: { running: 0, done: 0, failed: 0, total_ms: 0, last_ms: 0 },
      running: 1, waiting: 1, kv_tokens_total: 65536, kv_tokens_max: 1048576, kv_tokens_used: 3000, kv_tokens_cached: 1000, preemptions: 2,
      queue: { kv_reserve: 16384, backfill_ms: 60000 },
      requests: [
        { id: 4, state: "decode", prompt: 1000, computed: 1000, cached: 0, output: 10, max: 100, age_s: 2, tps: 50, ctx: 1010, kv_tokens: 1010, priority: 0 },
        { id: 5, state: "waiting", prompt: 9000, computed: 0, cached: 0, output: 0, max: 100, age_s: 1, tps: 0, ctx: 0, kv_tokens: 0, priority: 1, queue_pos: 0, wait: "kv_hold", held_s: 1, admit_tokens: 25000 },
        { id: 3, state: "done", prompt: 10, computed: 10, cached: 0, output: 1, max: 1, age_s: 3, tps: 1, ctx: 11, kv_tokens: 0, priority: 0 },
      ],
    } as unknown as Stats
    const q = snapshotOf("qwen27b", s, 7000)!
    expect(q.requests.map((r) => r.id)).toEqual([4, 5])
    expect(q.requests[1].wait).toBe("kv_hold")
    expect(q.kv_tokens_max).toBe(1048576)
    expect(q.max_num_seqs).toBe(8)
    // kvLayout.total must stay on elastic kv_tokens_total, never virtual carve kv_tokens_max.
    expect(kvLayout(q).total).toBe(65536)
    expect(snapshotOf("m", null, 0)).toBeNull()
  })
})
