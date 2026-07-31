FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/data /app/backups && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["npm", "start"]
