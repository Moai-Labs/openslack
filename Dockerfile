FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
# The volume mounts at /data (deploy.json). The image's own /data is chowned
# here, but a mounted volume shadows it with the filesystem the volume
# carries, and a freshly created volume's root directory is owned by
# root:root — so the entrypoint chowns the mount point once at startup, then
# drops privileges. Without this, node cannot even create .owner.lock on a
# fresh volume and the container crash-loops before the server could report
# its refusal. The server refuses to start in production unless /data is a
# separate mount it can write to, so an unmounted or unwritable volume still
# fails the deploy loudly.
RUN mkdir -p /data && chown node:node /data
# su-exec drops from root to node after the entrypoint chown. (Busybox
# provides flock, so util-linux is not needed here.)
RUN apk add --no-cache su-exec
USER root
# The server takes exclusive ownership of /data through flock(2) (busybox
# provides it). The shell opens the lock file on fd 9, takes the non-blocking
# exclusive flock, and exec's node — so the serving process itself inherits
# the locked descriptor and the kernel drops the lock when that process dies,
# however it dies. (The `flock FILE COMMAND` form would fork the command and
# leave the lock with a parent that outlives the intended owner.)
# The lock is retried for up to 30 seconds: during a deploy the replaced
# container can still hold the lock while it is being torn down, and an
# instant exit there would leave the new machine running with nothing
# listening until the next deploy. A lock that is still held after 30 seconds
# belongs to a live owner, and exiting (160, the wrapper's refusal code) is
# then the only honest move — never a takeover.
# OPENSLACK_LOCK_FD/OPENSLACK_LOCK_FILE tell the server it already runs under
# flock, so it does not re-exec itself; they are set per-process, never
# image-wide, so a restore started with docker exec still has to acquire the
# lock itself.
CMD ["sh", "-c", "chown node:node /data; exec 9>>/data/.owner.lock; n=0; until flock -x -n 9; do n=$((n+1)); if [ $n -ge 30 ]; then echo 'refusing to start: the data directory is owned by another live process' >&2; exit 160; fi; sleep 1; done; export OPENSLACK_LOCK_FD=9 OPENSLACK_LOCK_FILE=/data/.owner.lock; exec su-exec node node server.js"]
