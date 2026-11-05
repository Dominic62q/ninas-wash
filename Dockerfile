# The API. The web app is built and served by Vercel, so nothing here touches apps/web.
FROM node:22-slim
WORKDIR /app

# Dependencies first, so a code change does not reinstall them. The lockfile covers every workspace,
# so each workspace's package.json has to be present, even the ones this image does not use.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w @niinas/api --include-workspace-root

COPY packages/shared packages/shared
COPY apps/api apps/api

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
USER node
WORKDIR /app/apps/api
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["/app/node_modules/.bin/tsx", "src/server.ts"]
