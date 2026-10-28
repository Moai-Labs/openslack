// OpenSlack server: static pages, JSON API, SSE live updates.
// Node standard library only — no runtime npm dependencies.
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { Store } = require("./lib/store");
const { Api, sendJson } = require("./lib/api");
const lock = require("./lib/lock");
const { inspectStorage } = require("./lib/storage");
const pages = require("./lib/pages");
const LIMITS = require("./lib/limits");

const PORT = process.env.PORT != null && process.env.PORT !== "" ? Number(process.env.PORT) : 3000;
const isProduction = process.env.NODE_ENV === "production";

// The data directory holds everything that must survive a redeploy. In the
// deployed image it is the mounted volume named by DATA_DIR (deploy.json).
// Writability alone proves nothing — a container-local path is writable and
// still loses every message at the next deploy — so durability is claimed
// only for a writable path on the volume's own filesystem (see
// lib/storage.js), and a deployment that cannot provide one refuses to serve
// private data rather than quietly accepting data it cannot keep.
function resolveDataDir() {
  const wanted = process.env.DATA_DIR;
  if (wanted) {
    try {
      fs.mkdirSync(wanted, { recursive: true });
    } catch (err) {
      const message = `DATA_DIR ${wanted} cannot be created: ${err.message}`;
      if (isProduction) {
        return { dir: wanted, durable: false, refusal: `${message} Check the volume mount and the node user's write permission.` };
      }
      console.error(`${message}; falling back to local storage.`);
      return { dir: path.join(process.cwd(), "data"), durable: false };
    }
    const probe = path.join(path.resolve(wanted), `.write-probe-${process.pid}`);
    let writable = false;
    let writeError = "";
    try {
      fs.writeFileSync(probe, "ok");
      fs.unlinkSync(probe);
      writable = true;
    } catch (err) {
      writeError = err.message;
    }
    const verdict = writable ? inspectStorage(wanted) : { durable: false, reason: `not writable by this user (${writeError})` };
    if (verdict.durable) return { dir: path.resolve(wanted), durable: true };
    const message = `DATA_DIR ${wanted} is ${verdict.reason}, so nothing written there is guaranteed to survive a redeploy.`;
    if (isProduction) {
      return { dir: path.resolve(wanted), durable: false, refusal: `${message} Mount the persistent volume there.` };
    }
    console.warn(`warning: ${message} /healthz will report storage.durable=false.`);
    return { dir: path.resolve(wanted), durable: false };
  }
  if (isProduction) {
    return { dir: null, durable: false, refusal: "DATA_DIR is not set; without it messages live on the container's own filesystem and a redeploy loses them." };
  }
  const local = path.join(process.cwd(), "data");
  fs.mkdirSync(local, { recursive: true });
  return { dir: local, durable: false };
}

// A production start that cannot verify durable storage never opens the
// store — but it must not vanish, either: a process that just exits leaves
// the deployment's machine accepting connections and answering nothing,
// which is undiagnosable from outside (exactly the state a deployed refusal
// once produced). Instead it binds the port and serves exactly one thing:
// the verdict. /healthz answers 503 with durable:false and the refusal
// reason, every other route answers 503. No store is opened and the data
// directory is not touched, so nothing private can be read or written — the
// refusal stays as loud as before, and is now readable, until the volume is
// mounted properly and the deployment restarts.
function startDegraded(reason) {
  const server = http.createServer((req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", "default-src 'self'; frame-ancestors 'none'");
    let p = "/";
    try {
      p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    } catch {
      /* answered below */
    }
    const verdict = JSON.stringify({ ok: false, durable: false, reason: `not serving: ${reason}` });
    if (req.method === "GET" && p === "/healthz") {
      res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(verdict);
    }
    res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store", "retry-after": "300" });
    res.end(verdict);
  });
  server.listen(PORT, () => {
    console.error(`degraded: serving the storage refusal on ${PORT} until the persistent volume is mounted properly`);
  });
  const stop = () => {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return server;
}

const resolved = resolveDataDir();
if (resolved.refusal) {
  console.error(`refusing to serve private data: ${resolved.refusal}`);
  module.exports = startDegraded(resolved.refusal);
  return;
}
const { dir: dataDir, durable } = resolved;

// One owner per data directory: a restore run against a live server would be
// overwritten by the server's stale in-memory state on its next save. The
// exclusivity is an OS-backed flock(2) held for this process's lifetime; a
// process started outside flock (npm start) re-runs itself under it first.
// require.main keeps the module importable: the test suite starts the server
// in-process, where acquire() verifies no live owner instead.
lock.watchSupervisor(); // no-op unless a flock supervisor launched us
if (require.main === module && !lock.alreadyHeld(dataDir)) {
  try {
    lock.runUnderLock(dataDir, "server");
  } catch (err) {
    console.error(`refusing to start: ${err.message}`);
    process.exit(1);
  }
  return; // this process is now only the supervisor; the child serves
}
try {
  lock.acquire(dataDir, "server");
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

// Requests in flight, counted from when the server sees them until the
// response is finished or the socket is gone. Shutdown waits for this to hit
// zero: the process holds the data directory's exclusive lock, and exiting
// while a mutation request is still being received would release the store to
// a restore mid-write.
let inFlight = 0;
let shuttingDown = false;

const publicDir = path.join(__dirname, "public");
const staticFiles = new Map(
  ["app.js", "style.css"].map((f) => ["/" + f, { file: path.join(publicDir, f), type: f.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" }])
);

const server = http.createServer(async (req, res) => {
  inFlight++; // every request counts until its response is done or aborted
  res.on("close", () => inFlight--);
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

// Stop accepting requests and finish or abort every in-flight one BEFORE the
// process exits: only the exit drops the exclusive lock, so exiting early
// would hand the data directory to a restore while a mutation is mid-flight.
// The flock-based ownership is released by the kernel at process death —
// there is no lock file to unlink earlier, and none is.
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  api.closeAll(); // SSE responses never carry writes; end them now
  server.close(); // refuse new connections and requests
  // A generous ceiling: the drain exists so a slow client cannot be cut off
  // mid-mutation, so it must comfortably outlast a request that took seconds
  // to deliver its body — not add a new way to lose one.
  const deadline = Date.now() + 10000;
  const wait = setInterval(() => {
    if (inFlight <= 0 || Date.now() > deadline) {
      clearInterval(wait);
      server.closeAllConnections(); // idle keep-alive sockets
      process.exit(0); // the kernel drops the advisory lock here, not before
    }
  }, 25);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

module.exports = server;
