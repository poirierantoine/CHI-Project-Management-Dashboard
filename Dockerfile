# Stage 1 — builder: install deps and compile better-sqlite3's native C++ bindings
# better-sqlite3 uses a native Node addon (.node file), which must be compiled for
# the exact OS/architecture it will run on. Alpine needs python3, make, and g++.
FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json ./
RUN npm install

# Stage 2 — runtime: lean image without build tools
# We copy only the compiled node_modules from the builder stage.
# The final image is ~50MB instead of ~300MB if we kept the build tools.
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .
# /app/data is where SQLite writes its .db file — must be writable
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "server.js"]
