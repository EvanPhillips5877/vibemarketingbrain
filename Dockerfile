# MarketingBrain: one process serving the API, the built web app and the
# job scheduler. Built in two stages so the image ships without dev tools.
# Debian (glibc) rather than Alpine so sharp's prebuilt libvips binaries load.

FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY drizzle ./drizzle
COPY scripts ./scripts
# Typecheck is CI's job; here only the web bundle is produced.
RUN pnpm exec vite build --config web/vite.config.ts
RUN pnpm prune --prod

FROM node:24-bookworm-slim
ENV NODE_ENV=production
ENV PORT=5100
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/src ./src
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/dist ./dist
# Rendered creative assets live under /app/data (a volume in production).
# The volume arrives owned by root, so the entrypoint fixes ownership and
# then runs everything as the node user.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint && chmod +x /usr/local/bin/docker-entrypoint && mkdir -p /app/data && chown -R node:node /app
EXPOSE 5100
ENTRYPOINT ["docker-entrypoint"]
CMD ["node_modules/.bin/tsx", "src/index.ts"]
