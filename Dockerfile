# Node.js 22 Alpine - Ringan (~50MB) dengan modul node:sqlite bawaan
FROM node:22-alpine

# Environment configuration
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/stock_history.db

WORKDIR /app

# Salin berkas konfigurasi & install dependencies (xlsx)
COPY package.json ./
RUN npm install --omit=dev

COPY server.js database.js ./
COPY data/ ./data/
COPY js/ ./js/
COPY css/ ./css/
COPY index.html ./
COPY DetailPembelian-*.xls* ./

# Buat direktori data untuk volume persisten database SQLite
RUN mkdir -p /app/data

# Port aplikasi web
EXPOSE 3000

# Pemeriksaan kesehatan kontainer
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/dates', (res) => process.exit(res.statusCode === 200 ? 0 : 1))"

# Volume data persisten
VOLUME ["/app/data"]

# Jalankan server
CMD ["node", "server.js"]
