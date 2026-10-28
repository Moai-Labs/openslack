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
# drops privileges. The server refuses to start in production unless /data is
# a separate mount it can write to, so an unmounted or unwritable volume
# still fails the deploy loudly.
RUN mkdir -p /data && chown node:node /data
# lib/lock.js takes the data-directory lock with an OS flock via the
# util-linux flock(1) utility; the base image does not ship it. su-exec drops
# from root to node after the chown above.
RUN apk add --no-cache util-linux su-exec
CMD ["sh", "-c", "chown node:node /data && exec su-exec node node server.js"]
