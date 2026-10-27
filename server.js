// OpenSlack server: static pages, JSON API, SSE live updates.
// Node standard library only — no runtime npm dependencies.
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { Store } = require("./lib/store");
const { Api, sendJson } = require("./lib/api");
const pages = require("./lib/pages");
const LIMITS = require("./lib/limits");

const PORT = process.env.PORT != null && process.env.PORT !== "" ? Number(process.env.PORT) : 3000;

// The data directory holds everything that must survive a redeploy. In
// production it is a mounted volume named by DATA_DIR (deploy.json). If that
// path is not usable the server still boots on a local fallback, but /healthz
// reports storage.durable=false so the deployment check catches it.
function resolveDataDir() {
  const wanted = process.env.DATA_DIR;
  if (wanted) {
    try {
      fs.mkdirSync(wanted, { recursive: true });
      fs.accessSync(wanted, fs.constants.W_OK);
      return { dir: wanted, durable: true };
    } catch (err) {
      console.error(`DATA_DIR ${wanted} is not usable (${err.message}); falling back to local storage.`);
    }
  }
  const local = path.join(process.cwd(), "data");
  fs.mkdirSync(local, { recursive: true });
  return { dir: local, durable: false };
}

const { dir: dataDir, durable } = resolveDataDir();
const store = new Store(dataDir).init();
const api = new Api(store, (req) => {
  const host = req.headers.host || "localhost:3000";
  const proto = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || "http";
  return `${proto}://${host}`;
});

const publicDir = path.join(__dirname, "public");
const staticFiles = new Map(
  ["app.js", "style.css"].map((f) => ["/" + f, { file: path.join(publicDir, f), type: f.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" }])
);

const server = http.createServer(async (req, res) => {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("content-security-policy", "default-src 'self'; frame-ancestors 'none'");

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch {
    return sendJson(res, 400, { error: "Bad URL." });
  }

  try {
    if (await api.handle(req, res, pathname)) return;

    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { error: "Method not allowed." });
    }

    const stat = staticFiles.get(pathname);
    if (stat) {
      const body = fs.readFileSync(stat.file);
      res.writeHead(200, { "content-type": stat.type, "cache-control": "no-cache" });
      return res.end(body);
    }

    if (pathname === "/" || pathname === "/index.html") {
      return res.end(pages.home());
    }
    let m = pathname.match(/^\/join\/([A-Za-z0-9_-]+)$/);
    if (m) {
      return res.end(pages.join(m[1]));
    }
    m = pathname.match(/^\/w\/([a-z0-9-]+)$/);
    if (m) {
      return res.end(pages.chat(m[1]));
    }

    sendJson(res, 404, { error: "Not found." });
  } catch (err) {
    console.error("request error:", err);
    if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong." });
    else res.end();
  }
});

// Keep live connections healthy; never hold the process open on its own.
const beat = setInterval(() => api.heartbeat(), LIMITS.SSE_HEARTBEAT_SECONDS * 1000);
const sweep = setInterval(() => store.prune(), 60 * 60 * 1000);
beat.unref();
sweep.unref();

server.listen(PORT, () => {
  console.log(`listening on ${PORT}, data in ${dataDir} (${durable ? "volume" : "local fallback"})`);
});

async function shutdown() {
  api.closeAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

module.exports = server;
