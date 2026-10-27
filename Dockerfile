FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
# The volume mounts at /data (deploy.json): make sure the directory exists and
# is writable by the node user even before a volume is attached. The server
# refuses to start in production unless that path is on its own filesystem and
# writable, so an unmounted or unwritable volume fails the deploy loudly.
RUN mkdir -p /data && chown node:node /data
USER node
# The server takes exclusive ownership of /data through flock(2) (busybox
# provides it). The shell opens the lock file on fd 9, takes the non-blocking
# exclusive flock, and exec's node — so the serving process itself inherits
# the locked descriptor and the kernel drops the lock when that process dies,
# however it dies. (The `flock FILE COMMAND` form would fork the command and
# leave the lock with a parent that outlives the intended owner.)
# OPENSLACK_LOCK_FD/OPENSLACK_LOCK_FILE tell the server it already runs under
# flock, so it does not re-exec itself; they are set per-process, never
# image-wide, so a restore started with docker exec still has to acquire the
# lock itself.
CMD ["sh", "-c", "exec 9>>/data/.owner.lock; flock -x -n 9 || exit 1; export OPENSLACK_LOCK_FD=9 OPENSLACK_LOCK_FILE=/data/.owner.lock; exec node server.js"]
