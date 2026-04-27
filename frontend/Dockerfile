# Stage 1: build the Vite SPA
FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# VITE_MCP_URL=/mcp so the built JS calls the Nginx proxy, not localhost:8000
ARG VITE_MCP_URL=/mcp
ENV VITE_MCP_URL=$VITE_MCP_URL

RUN npm run build

# Stage 2: serve with Nginx
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
