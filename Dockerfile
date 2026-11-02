FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM dependencies AS tools
COPY --chown=node:node . .
RUN chown node:node /app
USER node

FROM tools AS production
USER root
RUN npm run build && chown -R node:node .next
USER node
ENV NODE_ENV=production
EXPOSE 3100
CMD ["sh", "-c", "node --import tsx scripts/check-config.ts && node .next/standalone/server.js"]
