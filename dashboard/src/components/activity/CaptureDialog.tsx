import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { copyText } from "@/lib/activity/clipboard";

/** GET /history/body: one request's stored body (History::body_at), local operator only. */
export interface StoredBody {
  rid: string;
  n: number;
  model: string;
  t1: number;
  request: string; // the POSTed JSON text, data: payloads replaced by their size
  reply: { text: string; finish: string }[];
}

interface CaptureDialogProps {
  rid: string;
  loc: string;
  open: boolean;
  onClose: () => void;
}

type View = "messages" | "reply" | "request" | "params";

/** Splits a raw reply into its reasoning block and the rest (Qwen-style <think>…</think>). */
export function splitReasoning(text: string): { reasoning: string; answer: string } {
  const close = text.indexOf("</think>");
  if (close < 0) return { reasoning: "", answer: text };
  const open = text.indexOf("<think>");
  const start = open >= 0 && open < close ? open + "<think>".length : 0;
  return { reasoning: text.slice(start, close).trim(), answer: text.slice(close + "</think>".length).trim() };
}

/** A message's content as text: a string, or the text parts of a content array. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (p && typeof p === "object") {
          const o = p as Record<string, unknown>;
          if (typeof o.text === "string") return o.text;
          if (typeof o.type === "string") return `[${o.type}]`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content, null, 2);
}

interface Msg {
  role: string;
  text: string;
  extra?: string;
}

/** The conversation of an OpenAI, Anthropic or Responses request body, as role + text rows. */
export function messagesOf(req: Record<string, unknown>): Msg[] {
  const out: Msg[] = [];
  if (typeof req.system === "string") out.push({ role: "system", text: req.system });
  else if (Array.isArray(req.system)) out.push({ role: "system", text: contentText(req.system) });
  if (typeof req.instructions === "string") out.push({ role: "system", text: req.instructions });
  const list = Array.isArray(req.messages) ? req.messages : Array.isArray(req.input) ? req.input : null;
  if (typeof req.prompt === "string") out.push({ role: "prompt", text: req.prompt });
  if (typeof req.input === "string") out.push({ role: "user", text: req.input });
  for (const m of list ?? []) {
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>;
    const role = typeof o.role === "string" ? o.role : typeof o.type === "string" ? o.type : "?";
    const calls = Array.isArray(o.tool_calls)
      ? o.tool_calls
          .map((c) => {
            const f = (c as Record<string, unknown>)?.function as Record<string, unknown> | undefined;
            return f ? `${String(f.name)}(${typeof f.arguments === "string" ? f.arguments : JSON.stringify(f.arguments)})` : "";
          })
          .filter(Boolean)
          .join("\n")
      : "";
    const text = contentText(o.content ?? o.output ?? o.arguments ?? "");
    const reasoning = typeof o.reasoning_content === "string" ? o.reasoning_content : "";
    out.push({
      role: o.tool_call_id ? `${role} (${String(o.tool_call_id)})` : typeof o.name === "string" ? `${role}: ${o.name}` : role,
      text,
      extra: [reasoning && `reasoning:\n${reasoning}`, calls && `tool calls:\n${calls}`].filter(Boolean).join("\n\n") || undefined,
    });
  }
  return out;
}

function MessageRow({ m, index }: { m: Msg; index: number }) {
  const long = m.text.length > 2000;
  const [all, setAll] = useState(!long);
  return (
    <div className="border-border border-b py-2">
      <div className="text-muted-foreground mb-1 font-mono text-[11px]">
        #{index + 1} {m.role} · {m.text.length.toLocaleString()} chars
      </div>
      <pre className="font-mono text-xs break-words whitespace-pre-wrap">
        {all ? m.text : m.text.slice(0, 2000)}
      </pre>
      {long && (
        <button className="text-primary mt-1 text-xs underline" onClick={() => setAll(!all)}>
          {all ? "show less" : `show all (${(m.text.length - 2000).toLocaleString()} more chars)`}
        </button>
      )}
      {m.extra && (
        <pre className="text-muted-foreground mt-1 font-mono text-xs break-words whitespace-pre-wrap">{m.extra}</pre>
      )}
    </div>
  );
}

/** The stored request and reply of one finished request (the Capture column's dialog). */
export function CaptureDialog({ rid, loc, open, onClose }: CaptureDialogProps) {
  const [body, setBody] = useState<StoredBody | null>(null);
  const [error, setError] = useState<string>("");
  const [view, setView] = useState<View>("messages");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setBody(null);
    setError("");
    api<StoredBody>(`history/body?rid=${encodeURIComponent(rid)}&loc=${encodeURIComponent(loc)}`)
      .then((b) => { if (live) setBody(b); })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [open, rid, loc]);

  let req: Record<string, unknown> = {};
  let reqPretty = "";
  if (body) {
    try {
      req = JSON.parse(body.request) as Record<string, unknown>;
      reqPretty = JSON.stringify(req, null, 2);
    } catch {
      reqPretty = body.request;
    }
  }
  const msgs = body ? messagesOf(req) : [];
  const params = Object.fromEntries(
    Object.entries(req).filter(([k]) => !["messages", "input", "system", "instructions", "prompt", "tools"].includes(k)),
  );
  const tools = Array.isArray(req.tools)
    ? req.tools.map((t) => {
        const o = t as Record<string, unknown>;
        const f = (o.function ?? o) as Record<string, unknown>;
        return String(f.name ?? "?");
      })
    : [];

  async function copyAll() {
    if (!body) return;
    const ok = await copyText(JSON.stringify({ ...body, request: req }, null, 2), null);
    setCopied(ok);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="flex max-h-[90vh] w-[90%] flex-col gap-0 p-0 sm:max-w-[90%]">
        <DialogHeader className="border-border border-b px-4 py-3">
          <DialogTitle className="text-lg font-bold">Request {rid}</DialogTitle>
          <DialogDescription className="text-muted-foreground text-sm">
            {body
              ? `${body.model} · ${new Date(body.t1).toLocaleString()} · ${msgs.length} messages · ${tools.length} tools`
              : error || "loading…"}
          </DialogDescription>
        </DialogHeader>
        {body && (
          <div className="flex items-center gap-2 px-4 pt-3">
            <Tabs value={view} onValueChange={(v) => setView(v as View)}>
              <TabsList>
                <TabsTrigger value="messages" className="px-3">Messages</TabsTrigger>
                <TabsTrigger value="reply" className="px-3">Reply</TabsTrigger>
                <TabsTrigger value="params" className="px-3">Params &amp; tools</TabsTrigger>
                <TabsTrigger value="request" className="px-3">Raw request</TabsTrigger>
              </TabsList>
            </Tabs>
            <Button variant="outline" size="sm" className="ml-auto" onClick={copyAll}>
              {copied ? "Copied!" : "Copy JSON"}
            </Button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {body && view === "messages" && msgs.map((m, i) => <MessageRow key={i} m={m} index={i} />)}
          {body && view === "reply" &&
            body.reply.map((c, i) => {
              const { reasoning, answer } = splitReasoning(c.text);
              return (
                <div key={i} className="border-border border-b py-2">
                  <div className="text-muted-foreground mb-1 font-mono text-[11px]">
                    choice {i} · finish {c.finish}
                  </div>
                  {reasoning && (
                    <details className="mb-2">
                      <summary className="text-muted-foreground cursor-pointer text-xs">
                        reasoning ({reasoning.length.toLocaleString()} chars)
                      </summary>
                      <pre className="text-muted-foreground font-mono text-xs break-words whitespace-pre-wrap">{reasoning}</pre>
                    </details>
                  )}
                  <pre className="font-mono text-xs break-words whitespace-pre-wrap">{answer || "(empty)"}</pre>
                </div>
              );
            })}
          {body && view === "params" && (
            <>
              <pre className="font-mono text-xs whitespace-pre-wrap">{JSON.stringify(params, null, 2)}</pre>
              <div className="text-muted-foreground mt-3 mb-1 text-xs">tools ({tools.length})</div>
              <pre className="font-mono text-xs whitespace-pre-wrap">{tools.join("\n") || "(none)"}</pre>
            </>
          )}
          {body && view === "request" && (
            <pre className="font-mono text-xs break-words whitespace-pre-wrap">{reqPretty}</pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
