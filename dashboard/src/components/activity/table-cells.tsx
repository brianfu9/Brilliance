import { useEffect, useRef, useState } from "react";
import { compactActivitySource } from "@/lib/activity/activitySource";
import { copyText } from "@/lib/activity/clipboard";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CaptureDialog } from "./CaptureDialog";

interface HeaderLabelProps {
  label: string;
  tooltip?: string;
}

/** A column header label with an optional dotted-underline tooltip. */
export function HeaderLabel({ label, tooltip }: HeaderLabelProps) {
  if (tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger className="cursor-help border-b border-dotted border-current align-middle">
          {label}
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    );
  }
  return label;
}

interface MetaCellProps {
  metadata: Record<string, string> | undefined;
}

/** Request metadata, collapsed to an ellipsis that lists the entries on hover. */
export function MetaCell({ metadata }: MetaCellProps) {
  const entries = Object.entries(metadata || {});
  if (entries.length === 0) {
    return <span className="text-muted-foreground">-</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger>
        <span className="text-muted-foreground hover:text-foreground cursor-help">...</span>
      </TooltipTrigger>
      <TooltipContent className="min-w-[12rem] max-w-[24rem] normal-case">
        <table className="w-full text-left">
          <tbody>
            {entries.map(([key, value]) => (
              <tr key={key} className="border-b border-white/10 last:border-0">
                <td className="py-1 pr-3 font-medium whitespace-nowrap text-primary">{key}</td>
                <td className="py-1 break-all">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TooltipContent>
    </Tooltip>
  );
}

interface MiddleEllipsisProps {
  value: string;
  tailLength?: number;
  className?: string;
}

/** Show the head of a long value, ellipsised in the middle, with the tail intact. */
export function MiddleEllipsis({ value, tailLength = 10, className = "" }: MiddleEllipsisProps) {
  const displayValue = value || "-";
  const head = displayValue.length > tailLength ? displayValue.slice(0, -tailLength) : displayValue;
  const tail = displayValue.length > tailLength ? displayValue.slice(-tailLength) : "";
  return (
    <span className={`flex min-w-0 items-baseline ${className}`} title={displayValue}>
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{head}</span>
      {tail ? <span className="shrink-0 whitespace-nowrap">{tail}</span> : null}
    </span>
  );
}

interface SourceCellProps {
  source: string;
}

/** The source/caller; a compacted Tailcat id copies on click and reveals itself in a tooltip. */
export function SourceCell({ source }: SourceCellProps) {
  const display = compactActivitySource(source);
  const compacted = !!source && display !== source;
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function copySource() {
    if (!(await copyText(source))) return;
    setCopied(true);
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => {
      setCopied(false);
    }, 1500);
  }

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  if (compacted) {
    return (
      <Tooltip>
        <TooltipTrigger
          className="cursor-copy whitespace-nowrap font-mono text-primary hover:underline"
          onClick={copySource}
          aria-label={copied ? "Copied full Tailcat caller ID" : "Copy full Tailcat caller ID"}
        >
          {copied ? "Copied!" : display}
        </TooltipTrigger>
        <TooltipContent className="max-w-[32rem] break-all font-mono normal-case">
          {source}
        </TooltipContent>
      </Tooltip>
    );
  }
  return <span>{display}</span>;
}

/**
 * The capture column (local): a request whose body History kept opens it in CaptureDialog;
 * otherwise "-", as ViewCaptureButton rendered with no capture.
 */
export function CaptureCell({ rid, loc }: { rid?: string; loc?: string }) {
  const [open, setOpen] = useState(false);
  if (!rid || !loc) return <span className="text-muted-foreground">-</span>;
  return (
    <>
      <button className="text-primary text-xs underline" onClick={() => setOpen(true)}>
        View
      </button>
      {open && <CaptureDialog rid={rid} loc={loc} open={open} onClose={() => setOpen(false)} />}
    </>
  );
}
