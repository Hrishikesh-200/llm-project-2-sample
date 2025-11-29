FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

# Install Node.js 18
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --production

# Copy application code
COPY . .

# Expose port (Fly.io uses PORT env variable)
EXPOSE 3000

# Start application
CMD ["node", "server.js"]
