// A model's /stats object (the live object /history sends five times a second) as the llama-swap
// fork's QueueSnapshot: the fork read the same fields from the same route (its queuepoll.go).
import type { Stats } from "@/lib/api"
import type { QueueRequest, QueueSnapshot } from "./types"

export function snapshotOf(model: string, s: Stats | null, receivedAtMs: number): QueueSnapshot | null {
  if (!s || s.kv_tokens_total === undefined) return null
  const requests: QueueRequest[] = (s.requests ?? [])
    .filter((r) => r.state !== "done")
    .map((r) => ({
      id: Number(r.id), tag: r.tag, state: r.state as QueueRequest["state"],
      prompt: r.prompt, computed: r.computed, cached: r.cached, output: r.output, max: r.max,
      kv_tokens: r.kv_tokens, age_s: r.age_s, ttft_s: r.ttft_s, tps: r.tps, priority: r.priority,
      queue_pos: r.queue_pos, wait: r.wait as QueueRequest["wait"], held_s: r.held_s, admit_tokens: r.admit_tokens,
    }))
  return {
    model, at_ms: s.now_ms, client_received_at_ms: receivedAtMs,
    kv_tokens_total: s.kv_tokens_total ?? 0, kv_tokens_used: s.kv_tokens_used ?? 0, kv_tokens_cached: s.kv_tokens_cached ?? 0,
    running: s.running ?? 0, waiting: s.waiting ?? 0, decode_tps: s.decode_tps ?? 0, prefill_tps: s.prefill_tps ?? 0,
    preemptions: s.preemptions ?? 0, queue: s.queue, requests,
  }
}
