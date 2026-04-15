FROM node:20-slim

# Install Playwright system dependencies + Java for Allure
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    libwayland-client0 \
    default-jre-headless \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Install Playwright Chromium
RUN npx playwright install chromium

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Create allure directories
RUN mkdir -p allure-results allure-report

# Expose port
EXPOSE 10000

# Start the server
CMD ["node", "dist/server.js"]