# syntax=docker/dockerfile:1
# The @pso/* framework packages are vendored in vendor/pso (pso docker:init --vendor): this build needs no access to a PSO checkout.
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY vendor ./vendor
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# pso.config*.json (when the project has one) holds the settings the runtime reads next to package.json (credentials are never written in it)
COPY --chown=node:node package.json pso.config*.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health/ready" >/dev/null || exit 1
CMD ["node", "dist/main.js"]
