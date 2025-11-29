# Use official Playwright image for Chromium support
FROM mcr.microsoft.com/playwright:v1.57.0-jammy

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json first for caching
COPY package*.json ./

# Install dependencies (including Chromium)
RUN npm install

# Copy all project files
COPY . .

# Expose the port you want (7860)
EXPOSE 7860

# Start the server (Force Node to use port=7860)
ENV PORT=7860

CMD ["npm", "start"]
