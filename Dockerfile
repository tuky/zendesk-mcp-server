

FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN npm install --global "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1].split('+')[0]")" \
 && pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsdown.config.ts ./
COPY scripts/bundle-manifest.mjs ./scripts/
COPY src ./src
RUN pnpm build && mkdir /data

FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ARG VERSION=0.0.0
ARG BASE_NAME=
ARG BASE_DIGEST=
LABEL org.opencontainers.image.title="zendesk-mcp-server" \
      org.opencontainers.image.description="Zendesk MCP server, HTTP transport (OAuth 2.1 authorization server included)." \
      org.opencontainers.image.vendor="tuky (derived from Fruggr)" \
      org.opencontainers.image.source="https://github.com/tuky/zendesk-mcp-server" \
      org.opencontainers.image.documentation="https://github.com/tuky/zendesk-mcp-server/blob/main/docs/http-deployment.md#container" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.base.name="${BASE_NAME}" \
      org.opencontainers.image.base.digest="${BASE_DIGEST}"
WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/dist ./dist
COPY --from=build --chown=1000:1000 /data /data
ENV NODE_ENV=production \
    TRANSPORT=http \
    OAUTH_STORE=file:///data/oauth-store.json
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /bin/bash /bin/dash /bin/sh
USER 1000:1000
EXPOSE 3000
VOLUME ["/data"]
ENTRYPOINT ["node", "/app/dist/index.js"]
