import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: {
    // Backend and shim tests run in node; the UI tests opt into jsdom per file.
    environment: "node",
  },
});
