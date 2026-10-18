# FreeWater platform server.
#   docker build -t freewater .
#   docker run -p 8080:8080 --env-file .env freewater
# Settings are explained in docs/RUNNING.md. The server checks them at start and refuses unsafe ones.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim
# pg_dump and psql, for backups and restore checks run from inside the container.
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 NODE_OPTIONS=--enable-source-maps
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json tsconfig.json .npmrc ./
COPY src src
COPY ops ops
ARG GIT_SHA=dev
ENV FW_VERSION=$GIT_SHA
# Never run as root.
USER node
EXPOSE 8080
# "Is the process up?" The load balancer should use /health/ready to decide whether to send traffic.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# SIGTERM lets it finish requests, save everything and hand the data to the next server (within 45 seconds).
STOPSIGNAL SIGTERM
CMD ["node", "--import", "tsx", "src/server/main.ts"]
