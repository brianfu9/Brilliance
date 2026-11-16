// The shell: the models down the side, the chosen view beside them, and the controls that apply
// to every view (the theme, the key of a server that asks for one). The time charts' window is chosen
// on the pages that have them (components/range.tsx).
import { useEffect, useState } from "react"
import { KeyRound, LayoutDashboard, Moon, Sun } from "lucide-react"
import { Logo } from "@/components/logo"
import { StateDot, stateOf } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { auth, type FleetModel } from "@/lib/api"
import { useFetched } from "@/lib/fetched"
import { fDur } from "@/lib/format"
import { fleet, useScope } from "@/lib/store"
import { hrefOf, setTheme, useRoute, useTheme } from "@/lib/ui"
import { ModelPage } from "@/pages/model"
import { Overview } from "@/pages/overview"

export default function App() {
  const scope = useScope(fleet)
  const route = useRoute()
  const theme = useTheme()
  const f = scope.live
  // A server without a key shows its fleet to its own machine only. From elsewhere the models come
  // from its public model list (/v1/models, what any API client reads: each model's name and
  // state), so every model's own pages and its Sandbox open from here; /server_info adds the file
  // and cards of the model the server answers with by default. Start and Stop stay with the
  // server's own machine.
  const { data: info, error: infoError } = useFetched<ServerInfo>(scope.refused ? "server_info" : null)
  const { data: list, error: listError } = useFetched<ModelList>(scope.refused ? "v1/models" : null, 2000)
  const solo: FleetModel | null = scope.refused && info?.server?.model
    ? { id: info.server.model, state: "resident", file: (info.engine?.container ?? "").split("/").pop() || undefined, capabilities: info.capabilities,
        tp: info.engine?.tensor_parallel, cards: info.engine?.devices?.map((d) => d.device) }
    : null
  const listed: FleetModel[] = (list?.data ?? []).filter((c) => c.id && !c.parent)
    .map((c) => ({ ...c, state: c.state ?? "resident", ...(solo && c.id === solo.id ? { file: solo.file, cards: c.cards ?? solo.cards, tp: c.tp ?? solo.tp } : {}) }))
  const remote = listed.length ? listed : solo ? [solo] : []
  const models = scope.refused ? remote : (f?.models ?? [])
  const shown = scope.refused
    ? (route.model !== null && remote.some((m) => m.id === route.model) ? route.model : remote.length === 1 ? remote[0].id : null)
    : route.model
  const model = models.find((m) => m.id === shown)
  const stale = scope.loaded && scope.error !== null
  useEffect(() => { document.title = shown ? shown + " · radiance" : "radiance" }, [shown])

  return (
    <TooltipProvider delay={150}>
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader>
            <a href={hrefOf(null)} className="flex items-center gap-2.5 px-2 py-1.5">
              <Logo className="size-7 text-primary" />
              <span className="text-[15px] font-semibold tracking-tight">radiance</span>
            </a>
          </SidebarHeader>
          <SidebarContent>
            {!scope.refused && (
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton isActive={route.model === null} render={<a href={hrefOf(null)} />}><LayoutDashboard />Overview</SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}
            <SidebarGroup>
              <SidebarGroupLabel>Models</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {models.map((m) => (
                    <SidebarMenuItem key={m.id}>
                      <SidebarMenuButton isActive={shown === m.id} tooltip={m.error ?? stateOf(m.state).label} render={<a href={hrefOf(m.id, route.model ? route.tab : "performance")} />}>
                        <span className="grid size-4 place-items-center"><StateDot state={m.state} busy={(m.in_flight ?? 0) > 0} /></span>
                        <span className="truncate">{m.id}</span>
                      </SidebarMenuButton>
                      {(m.in_flight ?? 0) > 0 && <SidebarMenuBadge className="num">{m.in_flight}</SidebarMenuBadge>}
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>
            <div className="num flex items-center justify-between px-2 pb-1 text-xs text-muted-foreground">
              <span>{f ? `${f.version} · up ${fDur(f.uptime_s)}` : info?.server?.version ? info.server.version : scope.refused && list ? "" : "Connecting…"}</span>
              {stale && <span className="text-warn">no answer</span>}
            </div>
          </SidebarFooter>
        </Sidebar>
        <SidebarInset className="min-w-0">
          <header className="sticky top-0 z-20 flex h-13 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur md:px-5">
            <SidebarTrigger className="-ml-1" />
            <span className="truncate text-sm font-medium">{shown ?? "Overview"}</span>
            <div className="ml-auto flex items-center gap-1.5">
              <Button variant="ghost" size="icon-sm" aria-label="Switch theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <Sun /> : <Moon />}</Button>
            </div>
          </header>
          <main className="min-w-0">
            {shown !== null ? <ModelPage key={shown} id={shown} tab={route.tab} model={model} models={models} local={!scope.refused} />
              : scope.refused ? (
                  // A server of several models without a key: no overview from elsewhere, but each model.
                  <div className="max-w-prose p-6 text-sm text-muted-foreground">
                    {remote.length > 1 ? "This server has no API key, so its overview is only available on the machine it runs on. Each model's own pages and its Sandbox open from here: pick one on the left."
                      : infoError && listError ? "This server has no API key, so its dashboard is only available on the machine it runs on. Start it with an API key to open it from other devices." : "Connecting…"}
                  </div>
                )
              : <Overview />}
          </main>
        </SidebarInset>
      </SidebarProvider>
      <KeyDialog />
    </TooltipProvider>
  )
}

/** /v1/models: a card for every model, with its state; aliases and adapters name a parent. */
interface ModelList { data?: (FleetModel & { parent?: string; state?: string })[] }

interface ServerInfo {
  server?: { model?: string; version?: string }
  capabilities?: Record<string, unknown>
  engine?: { container?: string; tensor_parallel?: number; devices?: { device: number }[] }
}

/** Asked once a request comes back refused: the server was started with an API key. */
function KeyDialog() {
  const [, bump] = useState(0)
  const [value, setValue] = useState("")
  useEffect(() => auth.subscribe(() => bump((n) => n + 1)), [])
  return (
    <Dialog open={auth.needed}>
      <DialogContent showCloseButton={false}>
        <form onSubmit={(e) => { e.preventDefault(); auth.set(value.trim()) }} className="contents">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><KeyRound className="size-4" />Enter API key</DialogTitle>
            <DialogDescription>This server requires an API key. It is saved in this browser only.</DialogDescription>
          </DialogHeader>
          <Input type="password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="API key" autoComplete="off" />
          <DialogFooter><Button type="submit" disabled={!value.trim()}>Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
