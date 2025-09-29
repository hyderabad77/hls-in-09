import { Hono } from "hono";
import { extractDaily } from "./providers/dailymotion";
import { extractFlash } from "./providers/flashplayer";
import { extractVk } from "./providers/vkspeed";
import type { Source } from "./types/sources";
import { handleHlsProxy } from "./proxy/index";
const app = new Hono<{ Bindings: CloudflareBindings }>();
app.options("/sources", (c) =>
  c.body(null, 204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  })
);
app.options("/hls/:encoded", (c) =>
  c.body(null, 200, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Max-Age": "86400",
  })
);
app.get("/hls/:encoded", async (c) => {
  return handleHlsProxy(c.req.raw);
});
app.get("/sources", async (c) => {
  const id = c.req.query("id");
  const host = (c.req.query("host") || "").toLowerCase();
  if (id) {
    try {
      let data: Source;
      switch (host) {
        case "dm":
          data = await extractDaily(id);
          break;
        case "fp":
          data = await extractFlash(id);
          break;
        case "vk":
          const iframe = `https://vkprime.com/embed-${id}-600x360.html`;
          data = await extractVk(iframe);
          break;
        default:
          return c.json(
              { success: false, error: "Unknown host" },
              400,
              { "Access-Control-Allow-Origin": "*" }
            );
      }
      return c.json(
        { success: true, url: id, host: host || undefined, data },
        200,
        { "Access-Control-Allow-Origin": "*" }
      );
    } catch (err: any) {
      const message = err?.message || "Internal error";
      return c.json(
        { success: false, error: message },
        500,
        { "Access-Control-Allow-Origin": "*" }
      );
    }
  }

  if (!id) {
    return c.json(
      { success: false, error: "Missing required query parameter: id" },
      400,
      { "Access-Control-Allow-Origin": "*" }
    );
  }
  return c.json(
    { success: false, error: "Missing required query parameter: host" },
    400,
    { "Access-Control-Allow-Origin": "*" }
  );
});

export default app;