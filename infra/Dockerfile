# Single image: builds the React frontend, then serves it from the Node backend.
# Build from the repository root:  docker build -f infra/Dockerfile -t bazhanka .

FROM node:22-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/src ./src
COPY --from=frontend /app/frontend/dist /app/frontend/dist
EXPOSE 3000
USER node
CMD ["node", "src/index.js"]
