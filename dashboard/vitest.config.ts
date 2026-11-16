import path from "node:path"
import { defineConfig } from "vitest/config"

// Unit tests of the page's pure logic (src/lib/activity: ported from the llama-swap fork's Activity page).
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
})
