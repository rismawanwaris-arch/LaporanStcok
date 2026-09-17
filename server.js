/**
 * Lightweight HTTP Server & REST API for Voucher Stock Analytics.
 * Handles Stock, Sales, and Purchase files (.csv, .xls, .xlsx).
 * Zero external npm dependencies other than SheetJS (xlsx). Ready for Docker and ZimaOS.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const XLSX = require('xlsx');

const StockDatabase = require('./database');
const StockDataParser = require('./data/stock-data');
const StockAnalytics = require('./js/stock-analytics');
const TransactionParser = require('./data/transaction-parser');
const InventoryRebalancer = require('./js/inventory-rebalancer');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const db = new StockDatabase();

// Auto-seed initial reports if database is empty
function autoSeedDefaultReports() {
  try {
    // 1. Stock report
    const stockDates = db.getAllDates();
    if (stockDates.length === 0) {
      const csvPath = path.join(__dirname, '1308 vcr.csv');
      if (fs.existsSync(csvPath)) {
        console.log('[Seed] Memuat data stok awal dari 1308 vcr.csv...');
        const csvText = fs.readFileSync(csvPath, 'utf8');
        const reportDate = extractDateFromCSV(csvText, '1308 vcr.csv');
        const parsed = StockDataParser.parse(csvText);
        db.saveReport(reportDate, '1308 vcr.csv', parsed);
        console.log(`[Seed] Data stok awal disimpan untuk tanggal ${reportDate}!`);
      }
    }

    // 2. Sales report
    const salesBatches = db.getAllSalesBatches();
    if (salesBatches.length === 0) {
      const salesPath = path.join(__dirname, '14-09-2026.xls');
      if (fs.existsSync(salesPath)) {
        console.log('[Seed] Memuat data penjualan awal dari 14-09-2026.xls...');
        const parsedSales = TransactionParser.parseSales(salesPath);
        db.saveSalesBatch(parsedSales.batchDate, '14-09-2026.xls', parsedSales);
        console.log(`[Seed] Data penjualan awal disimpan untuk tanggal ${parsedSales.batchDate}!`);
      }
    }

    // 3. Purchase report
    const purchBatches = db.getAllPurchaseBatches();
    if (purchBatches.length === 0) {
      const purchPath = path.join(__dirname, 'DetailPembelian-2026-09-15-sd-2026-09-15.xls');
      if (fs.existsSync(purchPath)) {
        console.log('[Seed] Memuat data pembelian awal dari DetailPembelian-2026-09-15-sd-2026-09-15.xls...');
        const parsedPurch = TransactionParser.parsePurchases(purchPath);
        db.savePurchaseBatch(parsedPurch.batchDate, 'DetailPembelian-2026-09-15-sd-2026-09-15.xls', parsedPurch);
        console.log(`[Seed] Data pembelian awal disimpan untuk tanggal ${parsedPurch.batchDate}!`);
      }
    }
  } catch (err) {
    console.warn('[Seed] Gagal auto-seed data default:', err.message);
  }
}

/**
 * Extracts report date (YYYY-MM-DD) from CSV text or filename.
 */
function extractDateFromCSV(csvText, fallbackFilename) {
  if (csvText) {
    const match = csvText.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (match) {
      const d = match[1].padStart(2, '0');
      const m = match[2].padStart(2, '0');
      const y = match[3];
      return `${y}-${m}-${d}`;
    }
  }

  if (fallbackFilename) {
    const fnMatch = fallbackFilename.match(/^(\d{2})(\d{2})/);
    if (fnMatch) {
      const year = new Date().getFullYear();
      return `${year}-${fnMatch[2]}-${fnMatch[1]}`;
    }
  }

  return new Date().toISOString().split('T')[0];
}

// MIME types mapping
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Analytics responses can run into the hundreds of KB to a few MB (full
// stock report JSON, 1000+ row analytics arrays); gzip on repetitive tabular
// JSON like this routinely shrinks it 5-10x, which matters most on the
// slower/metered networks a home-server app like this tends to run behind.
function pickEncoding(acceptEncoding) {
  const ae = acceptEncoding || '';
  if (/\bbr\b/.test(ae)) return 'br';
  if (/\bgzip\b/.test(ae)) return 'gzip';
  return null;
}

function compressBuffer(buf, encoding) {
  if (encoding === 'br') {
    return zlib.brotliCompressSync(buf, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } // fast enough to run per-request
    });
  }
  if (encoding === 'gzip') return zlib.gzipSync(buf);
  return buf;
}

// Text-based static assets compress well and are requested repeatedly
// (every page load); binary types (images, .xls/.xlsx, the .db backup
// download) are skipped since they're already compressed or gain nothing.
const COMPRESSIBLE_EXTENSIONS = new Set(['.html', '.css', '.js', '.json', '.csv', '.svg']);

// Compressed static files rarely change, so compress once per (file, mtime,
// encoding) and reuse the buffer on every subsequent request instead of
// re-running gzip/brotli on every single page load.
const staticCompressCache = new Map(); // `${filePath}|${encoding}` -> { mtimeMs, buf }

function serveStaticFile(req, res, filePath, stats, ext, headers) {
  const encoding = COMPRESSIBLE_EXTENSIONS.has(ext) ? pickEncoding(req.headers['accept-encoding']) : null;

  if (!encoding) {
    res.writeHead(200, headers);
    return fs.createReadStream(filePath).pipe(res);
  }

  const cacheKey = `${filePath}|${encoding}`;
  const cached = staticCompressCache.get(cacheKey);
  if (cached && cached.mtimeMs === stats.mtimeMs) {
    res.writeHead(200, { ...headers, 'Content-Encoding': encoding });
    return res.end(cached.buf);
  }

  fs.readFile(filePath, (err, raw) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('500 Internal Server Error');
    }
    // Static files are compressed once and cached, so a higher quality is
    // worth it here (unlike the per-request JSON path, which stays fast).
    const compressed = ext === '.html' || ext === '.css' || ext === '.js'
      ? (encoding === 'br'
        ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } })
        : zlib.gzipSync(raw, { level: 9 }))
      : compressBuffer(raw, encoding);
    staticCompressCache.set(cacheKey, { mtimeMs: stats.mtimeMs, buf: compressed });
    res.writeHead(200, { ...headers, 'Content-Encoding': encoding });
    res.end(compressed);
  });
}

function sendJson(req, res, statusCode, data) {
  const bodyBuf = Buffer.from(JSON.stringify(data), 'utf8');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Accept-Encoding'
  };

  // Below ~512 bytes the gzip/brotli frame overhead can exceed the savings —
  // skip compression for tiny responses.
  const encoding = bodyBuf.length > 512 ? pickEncoding(req.headers['accept-encoding']) : null;
  if (encoding) {
    headers['Content-Encoding'] = encoding;
    res.writeHead(statusCode, headers);
    return res.end(compressBuffer(bodyBuf, encoding));
  }

  res.writeHead(statusCode, headers);
  res.end(bodyBuf);
}

// Helper to read JSON body safely
function readJsonBody(req, res, callback) {
  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 35 * 1024 * 1024) { // 35MB max
      req.socket.destroy();
    }
  });

  req.on('end', () => {
    try {
      const payload = JSON.parse(body);
      callback(payload);
    } catch (err) {
      return sendJson(req, res, 400, { success: false, message: 'Format JSON request tidak valid: ' + err.message });
    }
  });
}

function getBufferFromPayload(payload) {
  if (payload.fileBase64) {
    const base64Str = payload.fileBase64.replace(/^data:.*?;base64,/, '');
    return Buffer.from(base64Str, 'base64');
  }
  if (payload.csvText) {
    return Buffer.from(payload.csvText, 'utf8');
  }
  return null;
}

/**
 * Converts a stock report buffer to CSV text, transcoding binary .xls/.xlsx
 * via SheetJS first (StockDataParser only understands raw CSV lines).
 */
function bufferToStockCsvText(buffer, filename) {
  const isExcel = filename && /\.xlsx?$/i.test(filename);
  if (!isExcel) {
    return buffer.toString('utf8');
  }
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_csv(sheet);
}

const server = http.createServer((req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, 'http://localhost');
  const pathname = parsedUrl.pathname;

  // --- API ROUTES ---

  // 1. Stock Dates & Data
  if (req.method === 'GET' && pathname === '/api/dates') {
    try {
      const dates = db.getAllDates();
      return sendJson(req, res, 200, { success: true, dates });
    } catch (err) {
      return sendJson(req, res, 500, { success: false, message: err.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/stock') {
    try {
      const reportDate = parsedUrl.searchParams.get('date');
      if (!reportDate) {
        return sendJson(req, res, 400, { success: false, message: 'Parameter "date" wajib disertakan.' });
      }

      const report = db.getReportByDate(reportDate);
      if (!report) {
        return sendJson(req, res, 404, { success: false, message: `Laporan untuk tanggal ${reportDate} tidak ditemukan.` });
      }

      return sendJson(req, res, 200, { success: true, report });
    } catch (err) {
      return sendJson(req, res, 500, { success: false, message: err.message });
    }
  }

  // Stock CSV Upload
  if (req.method === 'POST' && pathname === '/api/upload') {
    readJsonBody(req, res, (payload) => {
      try {
        const { filename, csvText, fileBase64, customDate } = payload;
        let textContent = csvText;

        if (!textContent && fileBase64) {
          const buf = getBufferFromPayload(payload);
          textContent = bufferToStockCsvText(buf, filename);
        }

        if (!textContent || typeof textContent !== 'string') {
          return sendJson(req, res, 400, { success: false, message: 'Data stok CSV tidak valid.' });
        }

        const reportDate = customDate || extractDateFromCSV(textContent, filename);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
          return sendJson(req, res, 400, { success: false, message: 'Format tanggal harus YYYY-MM-DD.' });
        }

        const parsed = StockDataParser.parse(textContent);
        if (!parsed.merks || Object.keys(parsed.merks).length === 0) {
          return sendJson(req, res, 400, { success: false, message: 'Format CSV stok tidak dikenali atau kosong.' });
        }

        const saved = db.saveReport(reportDate, filename || 'upload.csv', parsed);

        console.log(`[Upload Stok] Tersimpan untuk tanggal: ${reportDate} (${filename})`);
        return sendJson(req, res, 200, {
          success: true,
          message: `Laporan stok tanggal ${reportDate} berhasil disimpan!`,
          reportDate,
          summary: saved
        });
      } catch (err) {
        console.error('[Upload Stok Error]', err);
        return sendJson(req, res, 500, { success: false, message: 'Gagal memproses file stok: ' + err.message });
      }
    });
    return;
  }

  // DELETE Stock Report
  if (req.method === 'DELETE' && pathname === '/api/report') {
    try {
      const reportDate = parsedUrl.searchParams.get('date');
      if (!reportDate) {
        return sendJson(req, res, 400, { success: false, message: 'Parameter "date" wajib disertakan.' });
      }

      const deleted = db.deleteReportByDate(reportDate);
      if (!deleted) {
        return sendJson(req, res, 404, { success: false, message: `Laporan tanggal ${reportDate} tidak ditemukan.` });
      }

      return sendJson(req, res, 200, { success: true, message: `Laporan tanggal ${reportDate} berhasil dihapus.` });
    } catch (err) {
      return sendJson(req, res, 500, { success: false, message: err.message });
    }
  }

  // 2. Sales Batch API
  if (req.method === 'GET' && pathname === '/api/sales/batches') {
    try {
      const batches = db.getAllSalesBatches();
      return sendJson(req, res, 200, { success: true, batches });
    } catch (err) {
      return sendJson(req, res, 500, { success: false, message: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/upload-sales') {
    readJsonBody(req, res, (payload) => {
      try {
        const buffer = getBufferFromPayload(payload);
        if (!buffer) {
          return sendJson(req, res, 400, { success: false, message: 'Data berkas penjualan tidak ditemukan.' });
        }

        const parsed = TransactionParser.parseSales(buffer);
        const batchDate = payload.customDate || parsed.batchDate;
        const saved = db.saveSalesBatch(batchDate, payload.filename || 'sales.xls', parsed);

        console.log(`[Upload Penjualan] ${parsed.totalRows} baris tersimpan untuk tanggal ${batchDate}`);
        return sendJson(req, res, 200, {
          success: true,
          message: `Laporan penjualan tanggal ${batchDate} (${parsed.totalRows} transaksi) berhasil disimpan!`,
          batchDate,
          summary: saved
        });
      } catch (err) {
        console.error('[Upload Penjualan Error]', err);
        return sendJson(req, res, 500, { success: false, message: 'Gagal memproses file penjualan: ' + err.message });
      }
    });
    return;
  }

  if (req.method === 'DELETE' && pathname === '/api/sales') {
    try {
      const batchDate = parsedUrl.searchParams.get('date');
      if (!batchDate) return sendJson(req, res, 400, { success: false, message: 'Parameter "date" wajib disertakan.' });
      const deleted = db.deleteSalesBatch(batchDate);
      if (!deleted) {
        return sendJson(req, res, 404, { success: false, message: `Data penjualan tanggal ${batchDate} tidak ditemukan.` });
      }
      return sendJson(req, res, 200, { success: true, message: `Data penjualan tanggal ${batchDate} berhasil dihapus.` });
    } catch (err) {
      return sendJson(req, res, 500, { success: false, message: err.message });
    }
  }

  // 3. Purchases Batch API
  if (req.method === 'GET' && pathname === '/api/purchases/batches') {
    try {
      const batches = db.getAllPurchaseBatches();
      return sendJson(req, res, 200, { success: true, batches });
    } catch (err) {
      return sendJson(req, res, 500, { success: false, message: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/upload-purchases') {
    readJsonBody(req, res, (payload) => {
      try {
        const buffer = getBufferFromPayload(payload);
        if (!buffer) {
          return sendJson(req, res, 400, { success: false, message: 'Data berkas pembelian tidak ditemukan.' });
        }

        const parsed = TransactionParser.parsePurchases(buffer);
        const batchDate = payload.customDate || parsed.batchDate;
        const saved = db.savePurchaseBatch(batchDate, payload.filename || 'purchases.xls', parsed);

        console.log(`[Upload Pembelian] ${parsed.totalRows} baris tersimpan untuk tanggal ${batchDate}`);
        return sendJson(req, res, 200, {
          success: true,
          message: `Laporan pembelian tanggal ${batchDate} (${parsed.totalRows} transaksi) berhasil disimpan!`,
          batchDate,
          summary: saved
        });
      } catch (err) {
        console.error('[Upload Pembelian Error]', err);
        return sendJson(req, res, 500, { success: false, message: 'Gagal memproses file pembelian: ' + err.message });
      }
    });
    return;
  }

  if (req.method === 'DELETE' && pathname === '/api/purchases') {
    try {
      const batchDate = parsedUrl.searchParams.get('date');
      if (!batchDate) return sendJson(req, res, 400, { success: false, message: 'Parameter "date" wajib disertakan.' });
      const deleted = db.deletePurchaseBatch(batchDate);
      if (!deleted) {
        return sendJson(req, res, 404, { success: false, message: `Data pembelian tanggal ${batchDate} tidak ditemukan.` });
      }
      return sendJson(req, res, 200, { success: true, message: `Data pembelian tanggal ${batchDate} berhasil dihapus.` });
    } catch (err) {
      return sendJson(req, res, 500, { success: false, message: err.message });
    }
  }

  // 4. Smart Auto Upload (detects whether it is Stock, Sales, or Purchase automatically!)
  if (req.method === 'POST' && pathname === '/api/upload-auto') {
    readJsonBody(req, res, (payload) => {
      try {
        const buffer = getBufferFromPayload(payload);
        if (!buffer) return sendJson(req, res, 400, { success: false, message: 'Berkas kosong.' });

        const detectedType = TransactionParser.detectType(buffer);

        if (detectedType === 'sales') {
          const parsed = TransactionParser.parseSales(buffer);
          const batchDate = payload.customDate || parsed.batchDate;
          const saved = db.saveSalesBatch(batchDate, payload.filename || 'sales.xls', parsed);
          return sendJson(req, res, 200, {
            success: true,
            type: 'sales',
            message: `Otomatis terdeteksi: Laporan Penjualan (${parsed.totalRows} transaksi) tanggal ${batchDate}!`,
            summary: saved
          });
        }

        if (detectedType === 'purchases') {
          const parsed = TransactionParser.parsePurchases(buffer);
          const batchDate = payload.customDate || parsed.batchDate;
          const saved = db.savePurchaseBatch(batchDate, payload.filename || 'purchases.xls', parsed);
          return sendJson(req, res, 200, {
            success: true,
            type: 'purchases',
            message: `Otomatis terdeteksi: Laporan Pembelian (${parsed.totalRows} transaksi) tanggal ${batchDate}!`,
            summary: saved
          });
        }

        // Default or Stock CSV
        const textContent = bufferToStockCsvText(buffer, payload.filename);
        const reportDate = payload.customDate || extractDateFromCSV(textContent, payload.filename);
        const parsed = StockDataParser.parse(textContent);
        if (parsed.merks && Object.keys(parsed.merks).length > 0) {
          const overview = StockAnalytics.getOverview(parsed);
          const saved = db.saveReport(reportDate, payload.filename || 'upload.csv', parsed);
          return sendJson(req, res, 200, {
            success: true,
            type: 'stock',
            message: `Otomatis terdeteksi: Laporan Stok (${overview.global.totalItems} item) tanggal ${reportDate}!`,
            summary: saved
          });
        }

        return sendJson(req, res, 400, { success: false, message: 'Format berkas tidak dikenali sebagai Stok, Penjualan, ataupun Pembelian.' });
      } catch (err) {
        console.error('[Upload Auto Error]', err);
        return sendJson(req, res, 500, { success: false, message: 'Gagal memproses berkas otomatis: ' + err.message });
      }
    });
    return;
  }

  // 5. Analytics & Rebalancing APIs
  if (req.method === 'GET' && pathname === '/api/analytics/integrated') {
    try {
      const stockDate = parsedUrl.searchParams.get('stockDate') || undefined;
      const days = parseInt(parsedUrl.searchParams.get('days') || '1', 10);
      const region = parsedUrl.searchParams.get('region') || null;
      const data = db.getIntegratedData(stockDate, days, region);
      return sendJson(req, res, 200, { success: true, data });
    } catch (err) {
      return sendJson(req, res, 500, { success: false, message: err.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/analytics/rebalancing') {
    try {
      const stockDate = parsedUrl.searchParams.get('stockDate') || undefined;
      const days = parseInt(parsedUrl.searchParams.get('days') || '1', 10);
      const targetDays = parseInt(parsedUrl.searchParams.get('targetDays') || '7', 10);
      const region = parsedUrl.searchParams.get('region') || null;
      const integrated = db.getIntegratedData(stockDate, days, region);
      const recommendations = InventoryRebalancer.generateTransferRecommendations(integrated, { targetDays });
      return sendJson(req, res, 200, {
        success: true,
        stockDate: integrated.stockDate,
        salesDates: integrated.salesDates,
        count: recommendations.length,
        recommendations,
        availableItemGroups: integrated.availableItemGroups,
        availableRegions: integrated.availableRegions
      });
    } catch (err) {
      return sendJson(req, res, 500, { success: false, message: err.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/analytics/po') {
    try {
      const stockDate = parsedUrl.searchParams.get('stockDate') || undefined;
      const days = parseInt(parsedUrl.searchParams.get('days') || '1', 10);
      const targetDays = parseInt(parsedUrl.searchParams.get('targetDays') || '14', 10);
      const region = parsedUrl.searchParams.get('region') || null;
      const integrated = db.getIntegratedData(stockDate, days, region);
      const poSuggestions = InventoryRebalancer.generatePOSuggestions(integrated, { targetDays });
      return sendJson(req, res, 200, {
        success: true,
        stockDate: integrated.stockDate,
        salesDates: integrated.salesDates,
        count: poSuggestions.length,
        suggestions: poSuggestions,
        availableItemGroups: integrated.availableItemGroups,
        availableRegions: integrated.availableRegions
      });
    } catch (err) {
      return sendJson(req, res, 500, { success: false, message: err.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/analytics/fsn') {
    try {
      const stockDate = parsedUrl.searchParams.get('stockDate') || undefined;
      const days = parseInt(parsedUrl.searchParams.get('days') || '1', 10);
      const integrated = db.getIntegratedData(stockDate, days);
      const fsn = InventoryRebalancer.classifyFSN(integrated);
      return sendJson(req, res, 200, { success: true, fsn });
    } catch (err) {
      return sendJson(req, res, 500, { success: false, message: err.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/analytics/stockout-history') {
    try {
      const days = Math.min(180, Math.max(1, parseInt(parsedUrl.searchParams.get('days') || '30', 10)));
      const data = db.getStockoutHistory(days);
      return sendJson(req, res, 200, { success: true, data });
    } catch (err) {
      return sendJson(req, res, 500, { success: false, message: err.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/analytics/abc-aging') {
    try {
      const days = Math.min(365, Math.max(1, parseInt(parsedUrl.searchParams.get('days') || '90', 10)));
      const data = db.getABCAgingAnalysis(days);
      return sendJson(req, res, 200, { success: true, data });
    } catch (err) {
      return sendJson(req, res, 500, { success: false, message: err.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/analytics/outlet-performance') {
    try {
      const days = Math.min(180, Math.max(1, parseInt(parsedUrl.searchParams.get('days') || '30', 10)));
      const itemGroup = parsedUrl.searchParams.get('itemGroup') || null;
      const region = parsedUrl.searchParams.get('region') || null;
      const data = db.getOutletPerformance(days, itemGroup, region);
      return sendJson(req, res, 200, { success: true, data });
    } catch (err) {
      return sendJson(req, res, 500, { success: false, message: err.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/analytics/vendor-analysis') {
    try {
      const days = Math.min(365, Math.max(1, parseInt(parsedUrl.searchParams.get('days') || '90', 10)));
      const data = db.getVendorAnalysis(days);
      return sendJson(req, res, 200, { success: true, data });
    } catch (err) {
      return sendJson(req, res, 500, { success: false, message: err.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/analytics/trend') {
    try {
      const allowedBuckets = ['day', '3day', 'week', '2week', 'month'];
      let bucketType = parsedUrl.searchParams.get('bucket') || 'week';
      if (!allowedBuckets.includes(bucketType)) bucketType = 'week';
      const itemGroup = parsedUrl.searchParams.get('itemGroup') || null;
      const data = db.getTrendAnalysis(bucketType, itemGroup);
      return sendJson(req, res, 200, { success: true, data });
    } catch (err) {
      return sendJson(req, res, 500, { success: false, message: err.message });
    }
  }

  // Item Group (category) map — the stock CSV itself carries no category
  // column, only sales_records does, so the Matriks Stok Cabang table fetches
  // this once and cross-references item_code -> category client-side.
  if (req.method === 'GET' && pathname === '/api/analytics/item-groups') {
    try {
      const itemGroupMap = db.getItemGroupByCode();
      const availableItemGroups = db.getDistinctItemGroups();
      return sendJson(req, res, 200, { success: true, itemGroupMap, availableItemGroups });
    } catch (err) {
      return sendJson(req, res, 500, { success: false, message: err.message });
    }
  }

  // Outlet -> region (Bandung/Cimahi) map — like item-groups above, this has
  // no data-driven source (Bee Accounting exports don't carry a region
  // field), so the Matriks Stok Cabang table fetches this once and filters
  // its (client-side) outlet columns against it.
  if (req.method === 'GET' && pathname === '/api/analytics/outlet-regions') {
    try {
      const cimahiOutlets = Array.from(StockDataParser.CIMAHI_OUTLETS);
      return sendJson(req, res, 200, {
        success: true,
        cimahiOutlets,
        availableRegions: ['BANDUNG', 'CIMAHI']
      });
    } catch (err) {
      return sendJson(req, res, 500, { success: false, message: err.message });
    }
  }

  // 6. Database Management APIs
  if (req.method === 'GET' && pathname === '/api/database/info') {
    try {
      const info = db.getDatabaseInfo();
      return sendJson(req, res, 200, { success: true, info });
    } catch (err) {
      return sendJson(req, res, 500, { success: false, message: err.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/database/backup') {
    try {
      const dbFile = db.dbPath;
      if (!fs.existsSync(dbFile)) {
        return sendJson(req, res, 404, { success: false, message: 'File database tidak ditemukan.' });
      }
      const stat = fs.statSync(dbFile);
      const today = new Date().toISOString().split('T')[0];
      const filename = `stock_history_backup_${today}.db`;

      res.writeHead(200, {
        'Content-Type': 'application/x-sqlite3',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${filename}"`
      });
      const stream = fs.createReadStream(dbFile);
      return stream.pipe(res);
    } catch (err) {
      return sendJson(req, res, 500, { success: false, message: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/database/clear') {
    try {
      db.clearAllData();
      return sendJson(req, res, 200, { success: true, message: 'Seluruh data di database berhasil dikosongkan.' });
    } catch (err) {
      return sendJson(req, res, 500, { success: false, message: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/database/restore') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        if (buffer.length < 16) {
          return sendJson(req, res, 400, { success: false, message: 'File database tidak valid atau kosong.' });
        }
        const header = buffer.subarray(0, 16).toString();
        if (!header.startsWith('SQLite format 3')) {
          return sendJson(req, res, 400, { success: false, message: 'Format berkas harus berupa file database SQLite (.db).' });
        }

        db.close();
        fs.writeFileSync(db.dbPath, buffer);
        const { DatabaseSync } = require('node:sqlite');
        db.db = new DatabaseSync(db.dbPath);
        db.initSchema();

        return sendJson(req, res, 200, { success: true, message: 'Database berhasil dipulihkan (restore)!' });
      } catch (err) {
        return sendJson(req, res, 500, { success: false, message: 'Gagal mempulihkan database: ' + err.message });
      }
    });
    return;
  }

  // --- STATIC FILE SERVING ---
  let safePath = pathname === '/' ? '/index.html' : pathname;
  const normalizedPath = path.normalize(safePath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(__dirname, normalizedPath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const isHtml = ext === '.html';

    // index.html must always be revalidated (it's what picks up new `?v=`
    // cache-busted asset URLs); every other static file is safe to cache
    // for a long time since every reference to it in index.html already
    // carries a `?v=x.x` query string that changes when the file does.
    const headers = {
      'Content-Type': contentType,
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=2592000',
      'Vary': 'Accept-Encoding'
    };

    serveStaticFile(req, res, filePath, stats, ext, headers);
  });
});

autoSeedDefaultReports();

server.listen(PORT, HOST, () => {
  console.log(`====================================================`);
  console.log(`🚀 Voucher Analytics & Rebalancing Server Berjalan!`);
  console.log(`📡 URL Lokal:   http://localhost:${PORT}`);
  console.log(`🌐 URL Network: http://${HOST}:${PORT}`);
  console.log(`💾 Database:    ${db.dbPath}`);
  console.log(`====================================================`);

  // In a container, a missing DB_PATH usually means the compose/ZimaOS volume
  // mapping for /app/data didn't get applied — the DB would then be written
  // inside the container's own writable layer instead of the mounted host
  // folder, and get wiped the next time the container is recreated.
  if (process.env.NODE_ENV === 'production' && !process.env.DB_PATH) {
    console.warn(`⚠️  PERINGATAN: DB_PATH tidak diset padahal NODE_ENV=production.`);
    console.warn(`   Database mungkin TIDAK tersimpan ke volume persisten dan`);
    console.warn(`   bisa HILANG saat container di-restart/diperbarui.`);
    console.warn(`   Periksa pemetaan volume "/app/data" di docker-compose.yml / ZimaOS.`);
  }
});

// SIGTERM is what `docker stop`, container restarts, and ZimaOS updates send
// (not SIGINT) — without handling it, the process can be killed mid-write,
// leaving the SQLite file corrupted or truncated. Handle both the same way.
function gracefulShutdown(signal) {
  console.log(`\n[Shutdown] Menerima ${signal}, menutup koneksi database dan server dengan aman...`);
  db.backupDatabase();
  db.close();
  server.close(() => {
    process.exit(0);
  });
  // Force-exit if close() hangs (e.g. a lingering connection) so the
  // container's stop grace period doesn't run out and escalate to SIGKILL.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
