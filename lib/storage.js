// Storage honesty: does a data directory really hold persistent storage?
//
// Writability proves nothing — a container-local path is writable and still
// loses everything at the next deploy. Two checks decide durability:
//
//   1. the directory is on a filesystem of its own: its device id (statSync
//      .dev) differs from the container root filesystem's. A mounted volume
//      qualifies; a directory in the container's writable layer does not.
//      (fs.statfs().dev does not exist in Node — the device id comes from
//      statSync — and a path being merely writable says nothing.)
//   2. the location is not a temporary mount. /tmp, /var/tmp, /dev/shm and
//      /run can be separate filesystems yet vanish with the machine, so
//      being separate is never enough on its own.
//
// Both checks are cheap and platform-supported on Linux, where this deploys.
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

// Inspect a data directory. `stat` is injectable so tests can exercise every
// verdict (real mount, container-local path, temporary mount) without root.
function inspectStorage(dataDir, { stat = (p) => fs.statSync(p) } = {}) {
  const abs = path.resolve(dataDir);
  try {
    const dev = stat(abs).dev;
    const rootDev = stat(path.parse(abs).root || "/").dev;
    const temp = isTempLocation(abs);
    const onOwnFilesystem = dev !== rootDev;
    const durable = onOwnFilesystem && !temp;
    return {
      dataDir: abs,
      onOwnFilesystem,
      temp,
      durable,
      reason: onOwnFilesystem ? (temp ? "a temporary location that does not survive the machine" : "") : "on the container's own filesystem"
    };
  } catch (err) {
    return { dataDir: abs, onOwnFilesystem: false, temp: isTempLocation(abs), durable: false, reason: `not usable (${err.message})` };
  }
}

module.exports = { inspectStorage, isTempLocation };