# FreeWater platform server.
#   docker build -t freewater .
#   docker run -p 8080:8080 --env-file .env freewater
# Settings are explained in docs/RUNNING.md. The server checks them at start and refuses unsafe ones.

# The base image is pinned to an exact release so a rebuild can't quietly pick up different code.
# TODO(digest): pin it by digest too (a tag can be re-pointed). On a machine with Docker:
#   docker buildx imagetools inspect node:22.22.0-bookworm-slim --format '{{json .Manifest.Digest}}'
# then write both FROM lines as node:22.22.0-bookworm-slim@sha256:<digest>. Dependabot (docker) keeps it current.
FROM node:26.12.1-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:26.12.1-bookworm-slim
# poppler-utils: pdftocairo, pdfinfo, pdffonts, pdfimages and pdftotext read advertisers' PDF artwork (src/modules/artwork/pdf.ts),
# each as its own process with a time limit; without them PDFs are refused in plain words and SVG, PNG and JPG still work.
# pg_dump and psql (version 17, from PostgreSQL's own packages: it can back up any database from 13 to 17), for the
# daily backups and the weekly restore check run from inside the container.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 poppler-utils \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 NODE_OPTIONS=--enable-source-maps
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json tsconfig.json .npmrc ./
COPY src src
COPY books books
# Changes waiting for the database are kept here too (FW_SPOOL_DIR). Mount a volume on it so a restart keeps them.
RUN mkdir -p /var/lib/freewater/spool && chown -R node:node /var/lib/freewater
VOLUME /var/lib/freewater
ARG GIT_SHA=dev
ENV FW_VERSION=$GIT_SHA
# Never run as root.
USER node
EXPOSE 8080
# "Is the process up?" The load balancer should use /health/ready to decide whether to send traffic.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# SIGTERM lets it finish requests, save everything and hand the data to the next server (within 45 seconds).
STOPSIGNAL SIGTERM
# Runs the TypeScript through tsx (pinned in the lockfile). Building to JavaScript first is planned, not done: see
# docs/SUPPLY-CHAIN.md ("TypeScript at runtime"). No secret is baked in: every key comes from the host at run time.
CMD ["node", "--import", "tsx", "src/server/main.ts"]
