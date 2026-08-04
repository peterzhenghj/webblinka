import { defineConfig } from "vite";

// Project pages live at https://<user>.github.io/webblinka/. Override with
// BASE_PATH=/ when deploying to a custom domain or a user/org page.
const BASE = process.env.BASE_PATH ?? "/webblinka/";

export default defineConfig(({ command }) => ({
  base: command === "build" ? BASE : "/",
  worker: { format: "es" },
  build: { target: "es2022" },
  server: { host: "127.0.0.1" },
}));
