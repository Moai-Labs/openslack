FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER node
# DATA_DIR points at the mounted volume in deploy.json; without it the server
# falls back to local storage and /healthz reports durable=false.
CMD ["node", "server.js"]
