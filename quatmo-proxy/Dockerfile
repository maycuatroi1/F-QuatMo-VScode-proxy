# Use the official Bun base image
FROM oven/bun:1-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a

WORKDIR /app

# The summary CLI uses Python's standard library and the system HTTPS trust store.
RUN apk add --no-cache python3 ca-certificates

# Copy files
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --production --frozen-lockfile

# Copy source code and release metadata
COPY tsconfig.json ./
COPY release_manifest.json* ./
COPY src ./src

# Keep the engine inside this repository's build context for GitHub/Dokploy builds.
COPY summary_tool/generate_cli.py /opt/summary-tool/generate_cli.py
COPY summary_tool/engine /opt/summary-tool/engine
RUN PYTHONDONTWRITEBYTECODE=1 python3 /opt/summary-tool/generate_cli.py --help > /dev/null

# Ensure logs directory exists for SQLite database persistence
RUN mkdir -p /app/logs

# Declare volume for data persistence across container rebuilds/redeploys
VOLUME ["/app/logs"]

# Expose port
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV SUMMARY_CLI_PATH=/opt/summary-tool/generate_cli.py
ENV SUMMARY_PYTHON_BIN=/usr/bin/python3
ENV SUMMARY_LLM_MODEL=gemma-4-26b
ENV PYTHONDONTWRITEBYTECODE=1

# Run proxy server
CMD ["bun", "src/index.ts"]
