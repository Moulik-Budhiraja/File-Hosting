FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run assert:runtime
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bubblewrap \
        fonts-noto-cjk \
        fonts-noto-core \
    && chmod 4755 /usr/bin/bwrap \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 1001 nodejs \
    && useradd --uid 1001 --gid nodejs --create-home --shell /usr/sbin/nologin nextjs \
    && mkdir -p /data/objects \
    && chown -R nextjs:nodejs /data /app
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Next's file tracer cannot see libSQL's runtime-selected native package.
COPY --from=dependencies --chown=nextjs:nodejs /app/node_modules/@libsql ./node_modules/@libsql
USER nextjs
EXPOSE 3000
CMD ["npm", "run", "start:verified"]
