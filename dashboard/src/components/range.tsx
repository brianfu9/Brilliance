// The time window of the time charts (Performance and Overview): one choice, shared through ui.ts.
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { RANGES, setRange, useRange } from "@/lib/ui"
import { cn } from "@/lib/utils"

export function RangeToggle({ className }: { className?: string }) {
  const range = useRange()
  return (
    <ToggleGroup value={[String(range)]} onValueChange={(v) => { if (v.length) setRange(Number(v[v.length - 1])) }} variant="outline" size="sm" aria-label="Time range" className={cn(className)}>
      {RANGES.map(([s, label]) => <ToggleGroupItem key={s} value={String(s)} className="num px-2.5 text-xs">{label}</ToggleGroupItem>)}
    </ToggleGroup>
  )
}
