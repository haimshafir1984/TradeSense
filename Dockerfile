# Single container: the Express API (plus the autopilot scheduler) also serves the built React site.
# Persist /data (SQLite) with a volume; run exactly one replica.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci
COPY client client
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4000 \
    AUTOPILOT_DB_PATH=/data/autopilot.sqlite \
    PORTFOLIO_STORE_FILE_PATH=/data/portfolio.json
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci --omit=dev && npm cache clean --force
COPY server server
COPY --from=build /app/client/dist client/dist
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/src/index.js"]
