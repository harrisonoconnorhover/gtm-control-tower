FROM node:22.22.0-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22.22.0-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    CONTROL_TOWER_PERSISTENCE_ENABLED=true
WORKDIR /app
COPY --from=build /app/dist/standalone /app
COPY --from=build /app/node_modules/better-sqlite3 /app/node_modules/better-sqlite3
COPY --from=build /app/node_modules/bindings /app/node_modules/bindings
COPY --from=build /app/node_modules/file-uri-to-path /app/node_modules/file-uri-to-path
COPY --from=build /app/node_modules/react /app/node_modules/react
COPY --from=build /app/node_modules/react-dom /app/node_modules/react-dom
COPY --from=build /app/node_modules/react-server-dom-webpack /app/node_modules/react-server-dom-webpack
COPY --from=build /app/node_modules/scheduler /app/node_modules/scheduler
COPY --from=build /app/node_modules/acorn-loose /app/node_modules/acorn-loose
COPY --from=build /app/node_modules/neo-async /app/node_modules/neo-async
COPY --from=build /app/node_modules/webpack-sources /app/node_modules/webpack-sources
EXPOSE 3000
CMD ["node", "server.js"]
