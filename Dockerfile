# FreeWater platform server.
#   docker build -t freewater .
#   docker run -p 8080:8080 --env-file .env freewater
# Settings are explained in docs/RUNNING.md. The server checks them at start and refuses unsafe ones.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim
# pg_dump and psql (version 17, from PostgreSQL's own packages: it can back up any database from 13 to 17), for the
# daily backups and the weekly restore check run from inside the container.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 NODE_OPTIONS=--enable-source-maps
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json tsconfig.json .npmrc ./
COPY src src
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
