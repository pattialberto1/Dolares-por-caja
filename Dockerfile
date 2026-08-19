FROM node:22-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY publico ./publico

ENV PUERTO=3000 DIR_DATOS=/datos
VOLUME /datos
EXPOSE 3000

CMD ["node", "src/server.js"]
