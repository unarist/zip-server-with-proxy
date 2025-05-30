import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { upgradeWebSocket } from "hono/deno";
import { ZipWriter } from "@zip-js/zip-js";
import { dirname, resolve, SEPARATOR } from "@std/path";
import { parseArgs } from "node:util";

const args = parseArgs({
  options: {
    output: { type: "string", default: "./output" },
    port: { type: "string", default: "8080" },
    key: { type: "string" },
    cert: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (args.values.help) {
  console.log("Usage: deno run -A main.ts [--port <port>] [--output <outputdir>] [--tls-key <key> --tls-cert <cert>]");
  Deno.exit(0);
}

const app = new Hono();
app.use(logger());

/* ----- Remote Archiver ----- */

const outputPath = resolve(args.values.output!);
const archives = new Map<string, ZipWriter<unknown>>();

app.use("/archives", cors());
app.use("/archives/*", cors());
app.get("/archives", async (c) => {
  const path = c.req.query("path");
  const absPath = resolve(outputPath, path!);
  if (!absPath.startsWith(outputPath + SEPARATOR)) {
    return c.text("Invalid path", 400);
  }
  if (!(await Deno.stat(absPath).catch(() => null))?.isFile) {
    return c.text("Archive not found", 404);
  }
  return c.json({ path: path });
});
app.post("/archives", async (c) => {
  const { path } = await c.req.json() as { path: string };
  const absPath = resolve(outputPath, path);
  if (!absPath.startsWith(outputPath + SEPARATOR)) {
    return c.text("Invalid path", 400);
  }
  const id = Date.now().toString();
  await Deno.mkdir(dirname(absPath), { recursive: true });
  const file = await Deno.open(absPath, { create: true, write: true, truncate: true });
  const archive = new ZipWriter(file.writable, { level: 2 });
  archives.set(id, archive);
  return c.json({ id, path });
});
app.delete("/archives/:id", async (c) => {
  const id = c.req.param("id");
  const archive = archives.get(id);
  if (!archive) {
    return c.text("Archive not found", 404);
  }
  await archive.close();
  archives.delete(id);
  return c.text("Deleted", 200);
});
app.post("/archives/:id/:path{.+}", async (c) => {
  const id = c.req.param("id");
  const { url, headers } = await c.req.json() as { url: string; headers?: Record<string, string> };
  const archive = archives.get(id);
  if (!archive) {
    return c.text("Archive not found", 404);
  }
  const host = new URL(url).host;
  const proxy = proxies.get(host);
  if (!proxy) {
    return c.text("No proxy available for " + host, 500);
  }
  const resp = await proxy({ op: "fetch", url, headers, dest: c.req.url });
  if (resp.op === "error") {
    return c.text("Proxy failed: " + resp.error, 500);
  }
  return c.text("Added", 200);
});
app.put("/archives/:id/:path{.+}", async (c) => {
  const id = c.req.param("id");
  const path = c.req.param("path");
  const archive = archives.get(id);
  if (!archive) {
    return c.text("Archive not found", 404);
  }
  await archive.add(path, c.req.raw.body!);
  return c.text("Added", 200);
});

/* ----- Fetch Proxy ----- */

type ServerMessage = { op: "fetch"; url: string; headers?: Record<string, string>; dest: string };
type ClientMessage = { op: "success" } | { op: "error"; error: string };
type TransportMessage<T> = { mid: string; msg: T };

const proxies = new Map<string, (msg: ServerMessage) => Promise<ClientMessage>>();

const clientFn = () => {
  const ws = new WebSocket(`SERVER_ORIGIN/proxy/${location.host}`);
  ws.onmessage = async (evt) => {
    const { mid, msg } = JSON.parse(evt.data) as TransportMessage<ServerMessage>;
    const send = (msg: ClientMessage) =>
      ws.send(JSON.stringify({ mid, msg } satisfies TransportMessage<ClientMessage>));
    try {
      switch (msg.op) {
        case "fetch":
          {
            const resp = await fetch(msg.url, { headers: msg.headers, credentials: "include" });
            if (resp.ok) {
              // streamingはh2/quicが必要
              const bodyOpts = msg.dest.startsWith("https:")
                ? { body: resp.body, duplex: "half" }
                : { body: await resp.arrayBuffer() };
              const putResp = await fetch(msg.dest, { method: "PUT", ...bodyOpts });
              if (putResp.ok) {
                send({ op: "success" });
              } else {
                send({ op: "error", error: `Failed to PUT ${msg.dest}: status ${putResp.status}` });
              }
            } else {
              send({ op: "error", error: `Failed to fetch ${msg.url}: status ${resp.status}` });
            }
          }
          break;
      }
    } catch (e) {
      send({ op: "error", error: e instanceof Error ? e.message : typeof e === "string" ? e : e?.toString() ?? "" });
    }
  };
};

app.get("/proxy.js", (c) => {
  c.status(200);
  c.header("Content-Type", "application/javascript");
  const wsOrigin = new URL(c.req.url).origin.replace("http", "ws");
  return c.body(`(${clientFn.toString().replace(/SERVER_ORIGIN/g, wsOrigin)})()`);
});
app.get(
  "/proxy/:host",
  upgradeWebSocket((c) => {
    const { host } = c.req.param();
    const resolvers = new Map<string, (resp: ClientMessage) => void>();
    let counter = 0;
    const genMid = () => {
      counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
      return counter.toString();
    };
    return {
      onOpen: (_evt, ws) => {
        proxies.set(host, (msg) => {
          const mid = genMid();
          ws.send(JSON.stringify({ mid, msg } satisfies TransportMessage<ServerMessage>));
          const { promise, resolve } = Promise.withResolvers<ClientMessage>();
          resolvers.set(mid, resolve);
          return promise;
        });
      },
      onMessage: (evt, _ws) => {
        const { mid, msg } = JSON.parse(evt.data as string) as TransportMessage<ClientMessage>;
        resolvers.get(mid)?.(msg);
        resolvers.delete(mid);
      },
      onClose: () => {
        proxies.delete(host);
      },
    };
  }),
);

const tlsOptions = args.values.key && args.values.cert
  ? {
    key: Deno.readTextFileSync(args.values.key),
    cert: Deno.readTextFileSync(args.values.cert),
  }
  : {};
Deno.serve({ port: parseInt(args.values.port!), ...tlsOptions }, app.fetch);
