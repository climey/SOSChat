# Imagem do SOS Chat para o Railway (ou qualquer host com Docker).
# Debian traz o Chromium de verdade pelo apt (no Ubuntu é só um atalho para o snap, que não existe em
# container). A pré-consulta de placa/chassi abre esse Chromium sob demanda.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    CHROME_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 3000
CMD ["sh", "-c", "npm run migrate && npm run seed && npm start"]
