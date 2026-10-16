import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: { proxy: { "/api/v1": "http://127.0.0.1:3000" } },
  test: { environment: "node" },
});
