import index from "./index.html";
import { readFile } from "fs/promises";
import { join } from "path";

Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/": index,
    "/tiles/*": async (req) => {
      const url = new URL(req.url);
      const filePath = join("dist", url.pathname);
      try {
        const data = await readFile(filePath);
        const contentType = filePath.endsWith(".json") ? "application/json" : "application/octet-stream";
        return new Response(data, { headers: { "Content-Type": contentType } });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  },
  development: {
    hmr: true,
    console: true,
  },
});
