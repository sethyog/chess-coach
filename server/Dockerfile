FROM node:20-slim

# Install native Stockfish binary. apt provides Stockfish 15+ on Debian bookworm.
# The binary lands at /usr/games/stockfish; it's also added to PATH.
RUN apt-get update \
    && apt-get install -y --no-install-recommends stockfish \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production deps first (better layer caching).
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3001
CMD ["node", "server.js"]
