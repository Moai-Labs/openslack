// OpenSlack server: static pages, JSON API, SSE live updates.
// Node standard library only — no runtime npm dependencies.
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { Store } = require("./lib/store");
const { Api, sendJson } = require("./lib/api");
const { acquire } = require("./lib/lock");
const pages = require("./lib/pages");
const LIMITS = require("./lib/limits");

const PORT = process.env.PORT != null && process.env.PORT !== "" ? Number(process.env.PORT) : 3000;
const isProduction = process.env.NODE_ENV === "production";

// Is this path on a filesystem of its own — i.e. a mounted volume rather than
// the container's own writable layer, which vanishes with the container?
function isSeparateMount(p) {
  try {
    return fs.statfsSync(p).dev !== fs.statfsSync(path.parse(p).root).dev;
  } catch {
    return false;
  }
}

// The data directory holds everything that must survive a redeploy. In the
// deployed image it is the mounted volume named by DATA_DIR (deploy.json).
// Writability alone proves nothing — a container-local path is writable and
// still loses every message at the next deploy — so durability is claimed
// only for a writable path on a separate mount, and a deployment that cannot
// provide one refuses to start rather than quietly accepting private data it
// cannot keep.
function resolveDataDir() {
  const wanted = process.env.DATA_DIR;
  if (wanted) {
    const probe = path.join(wanted, `.write-probe-${process.pid}`);
    try {
      fs.mkdirSync(wanted, { recursive: true });
      fs.writeFileSync(probe, "ok");
      fs.unlinkSync(probe);
      const durable = isSeparateMount(wanted);
      if (!durable) {
        const message = `${wanted} is writable but on the container's own filesystem, so nothing written there survives a redeploy.`;
        if (isProduction) {
          console.error(`refusing to start: ${message} Mount the persistent volume there.`);
          process.exit(1);
        }
        console.warn(`warning: ${message} /healthz will report storage.durable=false.`);
      }
      return { dir: wanted, durable };
    } catch (err) {
      const message = `DATA_DIR ${wanted} is not usable: ${err.message}`;
      if (isProduction) {
        console.error(`refusing to start: ${message} Check the volume mount and the node user's write permission.`);
        process.exit(1);
      }
      console.error(`${message}; falling back to local storage.`);
    }
  } else if (isProduction) {
    console.error("refusing to start: DATA_DIR is not set; without it messages live on the container's own filesystem and a redeploy loses them.");
    process.exit(1);
  }
  const local = path.join(process.cwd(), "data");
  fs.mkdirSync(local, { recursive: true });
  return { dir: local, durable: false };
}

const { dir: dataDir, durable } = resolveDataDir();

// One owner per data directory: a restore run against a live server would be
// overwritten by the server's stale in-memory state on its next save.
//
// The lock can also be LOST while we run: if the holder process dies without
// a release() — an OOM kill, an operator's stray signal — the kernel frees
// the directory at that moment and another process may take it while our
// in-memory state is still live. From that point every write we make risks
// clobbering the new owner's data, so we fail closed: refuse requests, drop
// the live streams and exit, and let the deployment restart us (a restart
// takes the lock again before serving anything). release() during our own
// SIGTERM shutdown is an intentional release and reports nothing.
let dirLock;
try {
  dirLock = acquire(dataDir, "server", {
    onLost: () => {
      console.error("FATAL: the data-directory lock was lost unexpectedly; stopping all writes and exiting so the new owner's data cannot be clobbered. The deployment will restart this server.");
      api.closeAll();
      process.exit(1);
    }
  });
} catch (err) {
  console.error(`refusing to start: ${err.message}`);
  process.exit(1);
}

const store = new Store(dataDir).init();
const api = new Api(store, (req) => {
  const host = req.headers.host || "localhost:3000";
  const proto = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || "http";
  return `${proto}://${host}`;
}, { durable });

const publicDir = path.join(__dirname, "public");
const staticFiles = new Map(
  ["app.js", "style.css"].map((f) => ["/" + f, { file: path.join(publicDir, f), type: f.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" }])
);

const server = http.createServer(async (req, res) => {
  // A lost lock is worse than a slow server: refuse everything rather than
  // serve (and write) beside a new owner of the directory. alive() also
  // catches a holder death in the moments before its exit event lands.
  if (dirLock.lost || !dirLock.alive()) {
    return sendJson(res, 503, { error: "The server has lost exclusive ownership of its data directory and is shutting down." });
  }
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
  console.log(`listening on ${PORT}, data in ${dataDir} (${durable ? "persistent volume" : "NOT durable: local storage"})`);
});

async function shutdown() {
  api.closeAll();
  dirLock.release();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

module.exports = server;
