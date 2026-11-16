import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { copyText } from "@/lib/activity/clipboard";

interface ExportDialogProps {
  markdown: string;
  open: boolean;
  onClose: () => void;
}

/** The markdown export of the current page, with a copy button. */
export function ExportDialog({ markdown, open, onClose }: ExportDialogProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // execCommand("copy") is the only route on plain http, and it can still be
  // refused. When it is, select the source so the user can finish the job with
  // Ctrl+C rather than leaving them with a button that silently does nothing.
  async function copy() {
    const copied = await copyText(markdown, contentRef.current);
    setStatus(copied ? "copied" : "failed");
    if (!copied) selectSource();
    if (statusTimer.current !== null) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => {
      setStatus("idle");
      statusTimer.current = null;
    }, 2000);
  }

  function selectSource() {
    if (!preRef.current) return;
    const range = document.createRange();
    range.selectNodeContents(preRef.current);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  useEffect(
    () => () => {
      if (statusTimer.current !== null) clearTimeout(statusTimer.current);
    },
    [],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent
        ref={contentRef}
        className="flex max-h-[90vh] w-[90%] flex-col gap-0 p-0 sm:max-w-[90%]"
      >
        <DialogHeader className="border-border border-b px-4 py-3">
          <DialogTitle className="text-lg font-bold">Export</DialogTitle>
          <DialogDescription className="text-muted-foreground text-sm">
            The current page of results as markdown table source.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="bg-background border-border max-h-[60vh] overflow-auto rounded-md border">
            <pre ref={preRef} className="p-3 font-mono text-xs whitespace-pre">
              {markdown || "(no rows)"}
            </pre>
          </div>
        </div>

        {/*
          DialogFooter's -mx-4/-mb-4 cancel the default p-4 on DialogContent.
          This dialog sets p-0, so those offsets have to be zeroed or the bar
          hangs off the edges of the box.
        */}
        <DialogFooter className="border-border bg-card mx-0 mb-0 border-t px-4 py-3 sm:justify-end">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={copy} disabled={!markdown}>
            {status === "copied" ? "Copied!" : status === "failed" ? "Press Ctrl+C" : "Copy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
