FROM node:22-slim

WORKDIR /app

# Install Claude CLI (assumes it's available via npm or pre-installed)
# Users may need to adjust this depending on their Claude CLI installation method
RUN npm install -g @anthropic-ai/claude-code || true

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY prompts/ ./prompts/

ENTRYPOINT ["node", "dist/index.js"]
CMD ["watch"]
