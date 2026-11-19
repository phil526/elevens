# Game server + built client on one port. Build: docker build -t elevens .
# Run: docker run -p 8787:8787 -e ALLOWED_ORIGINS=https://your.domain elevens
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_SERVER_URL=
ENV VITE_SERVER_URL=$VITE_SERVER_URL
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0 SERVE_CLIENT=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Ranked records (RANKED_FILE) live here; mount a volume on /app/data to keep them across deploys.
RUN mkdir -p /app/data && chown node:node /app/data
ENV RANKED_FILE=/app/data/ranked.json
VOLUME /app/data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "dist/server/index.mjs"]
