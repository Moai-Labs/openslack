// Durability probes shared by the server and the persistence check.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Is this path on a filesystem of its own — i.e. a mounted volume rather than
// the container's own writable layer, which vanishes with the container?
//
// The st_dev field lives on stat(2), not on statfs(2): Node's statfsSync()
// result has no dev property at all (type, bsize, blocks, bfree, bavail,
// files, ffree), so comparing statfs devs silently compared undefined to
// undefined and reported every volume as container-local — which made the
// production server refuse to start on the real mounted volume. statSync()
// carries the real device id: a volume at /data reports a st_dev different
// from the root's, a plain directory under the container layer does not.
function isSeparateMount(p, stat = fs.statSync) {
  try {
    return stat(p).dev !== stat(path.parse(p).root).dev;
  } catch {
    return false;
  }
}

module.exports = { isSeparateMount };
