# Use the official Bun base image
FROM oven/bun:1-alpine

WORKDIR /app

# Copy files
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --production

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Ensure logs directory exists for SQLite database persistence
RUN mkdir -p /app/logs

# Declare volume for data persistence across container rebuilds/redeploys
VOLUME ["/app/logs"]

# Expose port
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Run proxy server
CMD ["bun", "src/index.ts"]
