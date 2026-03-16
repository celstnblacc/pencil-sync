FROM node:22-slim

WORKDIR /app

# Install Claude CLI as root — required for sync operations.
# If install fails, the container cannot function; fail the build explicitly.
RUN npm install -g @anthropic-ai/claude-code

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY prompts/ ./prompts/

# Drop root — run as the built-in unprivileged 'node' user (UID 1000).
# NOTE: the mounted /project volume must be readable/writable by UID 1000.
# On Linux hosts, set ownership: chown -R 1000:1000 /path/to/project
USER node

ENTRYPOINT ["node", "dist/index.js"]
CMD ["watch"]
