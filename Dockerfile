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
# refuses to start in production unless that path is a separate mount it can
# write to, so an unmounted or unwritable volume fails the deploy loudly.
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "server.js"]
