# Stage 1: Build
FROM node:24-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

# Stage 2: Runtime
FROM node:24-alpine

WORKDIR /app
COPY --from=builder /app ./

EXPOSE 3000
CMD ["node", "server.js"]