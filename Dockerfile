# ---- Build Stage ----
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files and install ALL dependencies (including dev for build)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source files
COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY vite.config.ts ./

# Build backend (TypeScript → dist) and frontend (Vite → frontend/dist)
RUN npm run build

# ---- Production Stage ----
FROM node:20-slim AS runner

WORKDIR /app

# Copy package files and install PRODUCTION dependencies only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy compiled backend
COPY --from=builder /app/backend/dist ./backend/dist

# Copy built frontend assets (served as static files by Express)
COPY --from=builder /app/frontend/dist ./frontend/dist

# Cloud Run sets PORT automatically; default to 8080
ENV PORT=8080

# Start the server (no --env-file flag; env vars are injected by Cloud Run)
CMD ["node", "backend/dist/server.js"]
