FROM node:24-bookworm AS builder

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source code and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

# Production image
FROM node:24-bookworm-slim

WORKDIR /app

# Copy package info and install production dependencies only
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Copy built artifacts from builder
COPY --from=builder /app/dist ./dist
COPY public/ ./public/

# Create directories for data and logs
RUN mkdir -p data logs

# Health check
HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.HOLOOL_PORT || 3000) + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Run the bot
CMD ["node", "dist/main.js"]
