// Storage honesty: does a data directory really hold persistent storage?
//
// Writability proves nothing — a container-local path is writable and still
// loses everything at the next deploy. Neither does being a separate mount:
// a tmpfs mounted anywhere (not only at the well-known temporary paths) or a
// symlink pointing into /dev/shm is separate too and just as ephemeral.
// The verdict therefore comes from the kernel's own view of the filesystem,
// /proc/self/mountinfo:
//
//   1. resolve the path's real location first — a symlink must not rename the
//      mount that actually backs it;
//   2. find the mount that actually covers the resolved path, and require it
//      to be a different mount from the container root's (a directory in the
//      writable layer is not persistence);
//   3. reject the mount's filesystem type when it is memory-backed or
//      otherwise ephemeral — tmpfs, ramfs, overlay, the kernel
//      pseudo-filesystems — wherever it happens to be mounted;
//   4. keep the temporary-path denylist as a conservative extra: an ext4
//      bind-mount at /tmp still does not make /tmp a home for data.
//
// All of this is Linux, which is the deployment platform; a path whose mount
// cannot be determined is reported as not durable rather than assumed good.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const TEMP_ROOTS = [...new Set(["/tmp", "/var/tmp", "/dev/shm", "/run", "/private/tmp", os.tmpdir()])]
  .map((t) => path.resolve(t))
  .filter((t) => t !== "/" && t !== "");

function isTempLocation(p) {
  return TEMP_ROOTS.some((t) => p === t || p.startsWith(t + path.sep));
}

// Filesystems whose contents do not outlive the machine or that exist only to
// expose kernel state, regardless of where they are mounted. Notably this
// includes tmpfs/ramfs at any pathname and the container's overlay root.
const EPHEMERAL_FS = new Set([
  "tmpfs", "ramfs", "devtmpfs", "mfs", "shm", "hugetlbfs",
  "overlay", "squashfs", "aufs",
  "proc", "sysfs", "devpts", "mqueue", "cgroup", "cgroup2", "cgroupfs",
  "securityfs", "debugfs", "tracefs", "pstore", "bpf", "configfs",
  "fusectl", "autofs", "binfmt_misc", "nsfs", "rpc_pipefs",
  "iso9660", "romfs", "cramfs", "jffs2"
]);

// mountinfo escapes spaces, tabs and backslashes in fields as \040, \011, \\.
function unescapeField(s) {
  return s
    .replace(/\\040/g, " ")
    .replace(/\\011/g, "\t")
    .replace(/\\134/g, "\\");
}

// Parse /proc/self/mountinfo:
//   id parent major:minor root mountpoint mountopts... - fstype source superopts
function parseMountInfo(text) {
  const mounts = [];
  for (const line of String(text || "").split("\n")) {
    const sep = line.indexOf(" - ");
    if (sep < 0) continue;
    const pre = line.slice(0, sep).split(" ");
    const post = line.slice(sep + 3).split(" ");
    if (pre.length < 5 || post.length < 2) continue;
    mounts.push({
      id: pre[0],
      mountPoint: unescapeField(pre[4]),
      fstype: post[0],
      source: unescapeField(post[1])
    });
  }
  return mounts;
}

// The deepest mount whose mount point contains p, component-wise ("/" covers
// everything; "/data" covers "/data/x" but not "/database"). Where mounts
// stack on the same point, the last entry in mountinfo is the visible one.
function coveringMount(mounts, p) {
  let best = null;
  for (const m of mounts) {
    const mp = m.mountPoint;
    const covers = mp === "/" ? true : p === mp || p.startsWith(mp.endsWith("/") ? mp : mp + "/");
    if (!covers) continue;
    if (!best || mp.length > best.mountPoint.length || (mp.length === best.mountPoint.length && mp === best.mountPoint)) best = m;
  }
  return best;
}

// The path's real location: symlinks must not rename the backing mount. The
// final component may not exist yet, so resolve the deepest existing ancestor
// and rejoin the remainder — the remainder cannot contain symlinks (nothing
// below it exists).
function realPathBestEffort(p, realpath = (x) => fs.realpathSync(x)) {
  let cur = p;
  for (;;) {
    try {
      return path.join(realpath(cur), path.relative(cur, p));
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      cur = parent;
    }
  }
}

function defaultMountInfo() {
  try {
    // Test seam only: a deployment reads the kernel's table. Nothing in the
    // image sets this, and a value here is no more trusted than DATA_DIR.
    return fs.readFileSync(process.env.OPENSLACK_MOUNTINFO_FILE || "/proc/self/mountinfo", "utf8");
  } catch {
    return null;
  }
}

// Inspect a data directory. `stat`, `realpath` and `mountInfo` are injectable
// so tests can exercise every verdict without root or real mounts.
function inspectStorage(dataDir, { stat = (p) => fs.statSync(p), realpath, mountInfo } = {}) {
  const abs = path.resolve(dataDir);
  const base = { dataDir: abs, temp: isTempLocation(abs) };
  try {
    stat(abs); // the directory must exist and be statable at all
  } catch (err) {
    return { ...base, resolvedPath: abs, mount: null, onOwnFilesystem: false, durable: false, reason: `not usable (${err.message})` };
  }
  const resolved = realPathBestEffort(abs, realpath);
  const text = mountInfo !== undefined ? mountInfo : defaultMountInfo();
  if (text == null) {
    return { ...base, resolvedPath: resolved, mount: null, onOwnFilesystem: false, durable: false, reason: "mount information is unavailable, so persistence cannot be verified" };
  }
  const mounts = parseMountInfo(text);
  const cov = coveringMount(mounts, resolved);
  const root = coveringMount(mounts, "/");
  const onOwnFilesystem = !!(cov && root && cov.mountPoint !== root.mountPoint);
  const mount = cov ? { point: cov.mountPoint, fstype: cov.fstype, source: cov.source } : null;
  const ephemeral = !!(cov && EPHEMERAL_FS.has(cov.fstype));
  const temp = isTempLocation(resolved);
  let reason = "";
  if (!cov) reason = "not inside any mounted filesystem";
  else if (!onOwnFilesystem) reason = "on the container's own filesystem";
  else if (ephemeral) reason = `on a ${cov.fstype} filesystem mounted at ${cov.mountPoint}, which does not survive the machine`;
  else if (temp) reason = "a temporary location that does not survive the machine";
  return { dataDir: abs, resolvedPath: resolved, mount, onOwnFilesystem, temp, durable: !reason, reason };
}

module.exports = { inspectStorage, isTempLocation, parseMountInfo, coveringMount, EPHEMERAL_FS };
