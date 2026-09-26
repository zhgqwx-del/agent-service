# syntax=docker/dockerfile:1
#
# Two stages. The build stage bundles an app into a single file and creates a portable production
# node_modules tree from the workspace lockfile. The runtime stage never resolves packages from the
# network, so it cannot silently pick transitive versions different from those built and tested in CI.
ARG APP=agent-runner
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-slim AS build
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
ARG APP
RUN node scripts/build-app.mjs ${APP}
# The first install has populated pnpm's store. Deploy offline from the same frozen lockfile and skip
# lifecycle scripts: all runtime dependencies are JavaScript-only and esbuild is build-stage-only.
RUN pnpm --filter "./apps/${APP}" --prod --offline --ignore-scripts --trust-lockfile --frozen-lockfile deploy /app/deploy

FROM node:${NODE_VERSION}-slim AS runtime
WORKDIR /app
ARG APP
ENV NODE_ENV=production
# Bind to every interface: the 127.0.0.1 default is unreachable from outside the container.
ENV RUNNER_HOST=0.0.0.0
ENV ROUTER_HOST=0.0.0.0
ENV APP=${APP}
COPY --from=build /app/deploy/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/${APP}/dist ./dist
# A writable state directory owned by the runtime user; otherwise the first blob write fails EACCES.
RUN mkdir -p /app/.data && chown -R node:node /app/.data
USER node
ENV BLOB_DIR=/app/.data/blobs
EXPOSE 8787 8080
STOPSIGNAL SIGTERM
# The two apps listen on different ports, so the check picks the right one from APP.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s CMD node -e "const p=process.env.APP==='agent-router'?(process.env.ROUTER_PORT||8080):(process.env.RUNNER_PORT||8787);fetch('http://127.0.0.1:'+p+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
