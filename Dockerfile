# erebrus-mcp image
#   stdio (default):  docker run --rm -i ghcr.io/netsepio/erebrus-mcp
#   local HTTP:       docker run --rm -p 3100:3100 ghcr.io/netsepio/erebrus-mcp --http
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV MCP_TRANSPORT=stdio
ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=3100
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3100
ENTRYPOINT ["node", "dist/index.js"]
