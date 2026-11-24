import { useEffect, useState, type CSSProperties } from "react";
import { cn } from "cn";
import type { QueueRequest, QueueSnapshot } from "@/lib/activity/types";
import {
  formatTick,
  formatTokens,
  kvLayout,
  kvTicks,
  requestKey,
  runningRequests,
  waitingRequests,
  type KVLayout,
  type KVSegment,
} from "@/lib/activity/queueView";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const pct = (tokens: number, total: number) => (100 * tokens) / Math.max(1, total);

/**
 * The KV pool's palette and bar styles. The bar is a self-contained widget
 * (used by the request queue panel, and later by other pages), so it carries
 * its own CSS: the .qp scope sets the palette variables the segment and key
 * classes read.
 * Categorical slots 1-4 of the validated reference palette (dataviz skill),
 * stepped per mode; status tones for the wait reasons.
 */
export const KV_POOL_CSS = `
  .qp {
    --q-s1: #2a78d6;
    --q-s2: #eb6834;
    --q-s3: #1baf7a;
    --q-s4: #eda100;
    --q-s5: #8a56c7;
    --q-s6: #0e9aa7;
    --q-s7: #d65780;
    --q-s8: #6b8e23;
    --q-cache: #b9b8b2;
    --q-warn: #c98500;
    --q-warn-ink: #8a5a00;
    --q-crit: #d03b3b;
    --q-crit-ink: #b42323;
    --q-ok: #1baf7a;
    --q-track: color-mix(in oklab, var(--muted) 70%, transparent);
  }
  .dark .qp {
    --q-s1: #3987e5;
    --q-s2: #d95926;
    --q-s3: #199e70;
    --q-s4: #c98500;
    --q-s5: #a577de;
    --q-s6: #26b5c2;
    --q-s7: #e57599;
    --q-s8: #8ab03c;
    --q-cache: #5f5e5a;
    --q-warn: #eda100;
    --q-warn-ink: #f2bd4d;
    --q-crit: #e66767;
    --q-crit-ink: #f09595;
    --q-ok: #34c48f;
  }
  .qp-bar {
    background: var(--q-track);
  }
  .qp-seg {
    cursor: default;
  }
  .qp-held {
    background: var(--c);
  }
  /* The reserve is a claim, not an allocation: the request's hue, hatched. */
  .qp-reserve {
    background: repeating-linear-gradient(45deg, var(--c) 0 2px, transparent 2px 6px);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--c) 60%, transparent);
  }
  .qp-cache {
    background: repeating-linear-gradient(135deg, var(--q-cache) 0 2px, transparent 2px 6px);
  }
  .qp-free {
    background: transparent;
  }
  .qp-seg-label {
    display: block;
    padding: 0 6px;
    line-height: 2rem;
    font-size: 11px;
    font-weight: 500;
    /* Near-black reads at 4.6:1 or better on all four fills, in both modes. */
    color: #0b0b0b;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .qp-ghost {
    border: 2px dashed var(--q-ok);
  }
  .qp-ghost-short {
    border-color: var(--q-crit);
    border-right-style: solid;
    border-right-width: 3px;
  }
  .qp-key {
    display: inline-block;
    width: 14px;
    height: 10px;
    border-radius: 2px;
  }
  .qp-key.qp-free {
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .qp-key.qp-ghost {
    background: transparent;
  }
  /* Segments slide and stretch as the pool refills between snapshots. */
  .qp-anim {
    transition: left 200ms ease, width 200ms ease;
  }
`;

/** window.matchMedia("(prefers-reduced-motion: reduce)"), live-tracked. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

interface Props {
  snapshot: QueueSnapshot;
  slots: Map<string, number>;
}

/**
 * The KV pool bar: one full-attention token axis. Each running request's
 * held context, then the output reserve the KV-fit gate counts for it on
 * top, then the prefix cache of finished turns, then free — with the head
 * of the waiting line drawn as a ghost over what the running requests
 * commit.
 */
export function KvPoolBar({ snapshot, slots }: Props) {
  const reducedMotion = usePrefersReducedMotion();
  const l = kvLayout(snapshot);
  const running = runningRequests(snapshot);
  const ghost = headGhost(snapshot, l);

  function slotOf(r: QueueRequest): number {
    return slots.get(requestKey(snapshot.model, r)) ?? 0;
  }

  // The fork names a segment with the request's short session name (joined
  // from its in-flight entries); this server has no in-flight data, so the
  // segment is named by the request's id.
  function shortName(r: QueueRequest): string {
    return `#${r.id}`;
  }

  function segmentTitle(g: KVSegment): string {
    const t = formatTokens(g.tokens);
    switch (g.kind) {
      case "held":
        return `#${g.request!.id} ${shortName(g.request!)}: holds ${t} of context`;
      case "reserve": {
        const r = g.request!;
        // While prefilling the gap is the prompt still to compute, not just output.
        if (r.state === "prefill") {
          const left = Math.max(0, r.prompt - r.computed);
          return `#${r.id} ${shortName(r)}: ${formatTokens(left)} of prompt to compute + ${formatTokens(Math.max(0, g.tokens - left))} output room`;
        }
        return `#${r.id}: ${t} reserved for output (--admit-kv-reserve)`;
      }
      case "cache":
        return `prefix cache of finished turns: ${t}, evicted on demand`;
      default:
        return `free: ${t}`;
    }
  }

  return (
    <div className="qp mt-2">
      <style>{KV_POOL_CSS}</style>
      <div
        className="qp-bar relative h-8 rounded-[4px]"
        role="img"
        aria-label={`KV pool: ${formatTokens(l.committed)} committed by ${running.length} running, ${formatTokens(l.cache)} cache, ${formatTokens(l.free)} free of ${formatTokens(l.total)}`}
      >
        {l.segments.map((g, i) => {
          const w = pct(g.tokens, l.total);
          return (
            <Tooltip key={g.kind + (g.request?.id ?? "") + i}>
              <TooltipTrigger
                render={
                  <div
                    className={cn(
                      `qp-seg qp-${g.kind} absolute inset-y-0 overflow-hidden rounded-[4px] text-left`,
                      !reducedMotion && "qp-anim",
                    )}
                    style={
                      {
                        left: `calc(${pct(g.start, l.total)}% + 1px)`,
                        width: `max(0px, calc(${w}% - 2px))`,
                        "--c": `var(--q-s${g.request ? (slotOf(g.request) % 8) + 1 : 1})`,
                      } as CSSProperties
                    }
                    aria-label={segmentTitle(g)}
                  />
                }
              >
                {g.kind === "held" && w >= 7 && g.request ? (
                  <span className="qp-seg-label">
                    {shortName(g.request)} · {formatTokens(g.tokens)}
                  </span>
                ) : null}
              </TooltipTrigger>
              <TooltipContent>{segmentTitle(g)}</TooltipContent>
            </Tooltip>
          );
        })}
        {ghost ? (
          <div
            className={`qp-ghost pointer-events-none absolute -inset-y-1 rounded-[5px] ${
              ghost.fits ? "qp-ghost-fit" : "qp-ghost-short"
            }`}
            style={{
              left: `calc(${ghost.left}% + 1px)`,
              width: `max(6px, calc(${ghost.width}% - 2px))`,
            }}
          />
        ) : null}
      </div>
      <div className="relative mt-1 h-4 text-[10px] text-muted-foreground tabular-nums">
        {kvTicks(l.total).filter((t) => pct(t, l.total) < 94).map((t) => (
          <span key={t} className="absolute -translate-x-1/2" style={{ left: `${pct(t, l.total)}%` }}>
            {formatTick(t)}
          </span>
        ))}
        <span className="absolute right-0">{formatTokens(l.total)}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="qp-key qp-held" style={{ "--c": "var(--q-s1)" } as CSSProperties} />
          held context
        </span>
        <span className="flex items-center gap-1">
          <span className="qp-key qp-reserve" style={{ "--c": "var(--q-s1)" } as CSSProperties} />
          output reserve
        </span>
        <span className="flex items-center gap-1">
          <span className="qp-key qp-cache" />
          prefix cache (evictable)
        </span>
        <span className="flex items-center gap-1">
          <span className="qp-key qp-free" />
          free
        </span>
        {ghost ? (
          <span className="flex items-center gap-1 text-foreground">
            <span
              className={`qp-key qp-ghost ${ghost.fits ? "qp-ghost-fit" : "qp-ghost-short"}`}
            />{" "}
            next in line #{ghost.head.id} needs {formatTokens(ghost.need)}{" "}
            {ghost.fits ? ": fits" : `: short ${formatTokens(ghost.short)}`}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// The head of the line drawn as a ghost after what running requests commit.
function headGhost(s: QueueSnapshot, l: KVLayout) {
  const head = waitingRequests(s)[0];
  const need = head?.admit_tokens ?? 0;
  if (!head || need <= 0) return null;
  const fits = need <= l.room;
  return {
    head,
    need,
    fits,
    left: pct(l.committed, l.total),
    width: pct(Math.min(need, l.room), l.total),
    short: Math.max(0, need - l.room),
  };
}
