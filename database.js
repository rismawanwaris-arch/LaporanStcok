/**
 * Database Module for Voucher Stock, Sales, and Purchase History.
 * Uses Node.js built-in `node:sqlite` (DatabaseSync).
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

class StockDatabase {
  constructor(dbPath) {
    this.dbPath = dbPath || process.env.DB_PATH || path.join(__dirname, 'data', 'stock_history.db');
    
    // Ensure directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(this.dbPath);
    this.initSchema();
  }

  /**
   * Initializes SQLite tables and indexes.
   */
  initSchema() {
    this.db.exec(`
      PRAGMA foreign_keys = ON;

      -- 1. Daily Stock Reports
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_date TEXT UNIQUE NOT NULL,
        filename TEXT,
        total_stock INTEGER DEFAULT 0,
        total_items INTEGER DEFAULT 0,
        total_outlets INTEGER DEFAULT 0,
        total_merks INTEGER DEFAULT 0,
        raw_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS stock_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_id INTEGER NOT NULL,
        report_date TEXT NOT NULL,
        merk TEXT NOT NULL,
        item_code TEXT NOT NULL,
        item_name TEXT NOT NULL,
        outlet TEXT NOT NULL,
        stock INTEGER NOT NULL,
        FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_records_date ON stock_records(report_date);
      CREATE INDEX IF NOT EXISTS idx_records_item ON stock_records(item_code);
      CREATE INDEX IF NOT EXISTS idx_records_outlet ON stock_records(outlet);

      -- 2. Daily Sales Batches & Granular Records
      CREATE TABLE IF NOT EXISTS sales_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_date TEXT UNIQUE NOT NULL,
        filename TEXT,
        total_rows INTEGER DEFAULT 0,
        total_qty INTEGER DEFAULT 0,
        total_amount REAL DEFAULT 0,
        total_profit REAL DEFAULT 0,
        total_outlets INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sales_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id INTEGER NOT NULL,
        transaction_no TEXT,
        transaction_date TEXT NOT NULL,
        transaction_time TEXT,
        outlet TEXT NOT NULL,
        customer TEXT,
        item_code TEXT NOT NULL,
        item_name TEXT NOT NULL,
        item_group TEXT,
        qty INTEGER NOT NULL,
        unit TEXT DEFAULT 'PCS',
        sell_price REAL DEFAULT 0,
        discount REAL DEFAULT 0,
        subtotal REAL DEFAULT 0,
        cogs REAL DEFAULT 0,
        profit_loss REAL DEFAULT 0,
        cashier TEXT,
        FOREIGN KEY (batch_id) REFERENCES sales_batches(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sales_date ON sales_records(transaction_date);
      CREATE INDEX IF NOT EXISTS idx_sales_outlet ON sales_records(outlet);
      CREATE INDEX IF NOT EXISTS idx_sales_item ON sales_records(item_code);

      -- 3. Daily Purchase Batches & Granular Records
      CREATE TABLE IF NOT EXISTS purchase_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_date TEXT UNIQUE NOT NULL,
        filename TEXT,
        total_rows INTEGER DEFAULT 0,
        total_qty INTEGER DEFAULT 0,
        total_amount REAL DEFAULT 0,
        total_outlets INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS purchase_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id INTEGER NOT NULL,
        invoice_no TEXT,
        purchase_date TEXT NOT NULL,
        ref_invoice TEXT,
        outlet TEXT NOT NULL,
        vendor TEXT,
        item_code TEXT NOT NULL,
        item_name TEXT NOT NULL,
        qty INTEGER NOT NULL,
        unit TEXT DEFAULT 'PCS',
        unit_price REAL DEFAULT 0,
        subtotal REAL DEFAULT 0,
        total_invoice REAL DEFAULT 0,
        FOREIGN KEY (batch_id) REFERENCES purchase_batches(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_purch_date ON purchase_records(purchase_date);
      CREATE INDEX IF NOT EXISTS idx_purch_outlet ON purchase_records(outlet);
      CREATE INDEX IF NOT EXISTS idx_purch_item ON purchase_records(item_code);
    `);
  }

  // ==========================================
  // STOCK REPORTS
  // ==========================================

  saveReport(reportDate, filename, parsedData, overview) {
    const now = new Date().toISOString();
    const rawJson = JSON.stringify(parsedData);
    
    const totalStock = overview.global.totalStock || 0;
    const totalItems = overview.global.totalItems || 0;
    const totalOutlets = overview.global.totalOutlets || 0;
    const totalMerks = overview.global.totalMerks || 0;

    const existing = this.db.prepare(`SELECT id FROM reports WHERE report_date = ?`).get(reportDate);

    let reportId;
    if (existing) {
      reportId = existing.id;
      this.db.prepare(`
        UPDATE reports 
        SET filename = ?, total_stock = ?, total_items = ?, total_outlets = ?, total_merks = ?, raw_json = ?, created_at = ?
        WHERE id = ?
      `).run(filename, totalStock, totalItems, totalOutlets, totalMerks, rawJson, now, reportId);

      this.db.prepare(`DELETE FROM stock_records WHERE report_id = ?`).run(reportId);
    } else {
      const insertReport = this.db.prepare(`
        INSERT INTO reports (report_date, filename, total_stock, total_items, total_outlets, total_merks, raw_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertReport.run(reportDate, filename, totalStock, totalItems, totalOutlets, totalMerks, rawJson, now);
      
      const newRow = this.db.prepare(`SELECT id FROM reports WHERE report_date = ?`).get(reportDate);
      reportId = newRow.id;
    }

    this.db.exec('BEGIN TRANSACTION;');
    try {
      const insertRecord = this.db.prepare(`
        INSERT INTO stock_records (report_id, report_date, merk, item_code, item_name, outlet, stock)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      Object.entries(parsedData.merks).forEach(([merkName, merkObj]) => {
        Object.values(merkObj.items).forEach(item => {
          Object.entries(item.stocks).forEach(([outlet, stockQty]) => {
            if (stockQty > 0) {
              insertRecord.run(reportId, reportDate, merkName, item.code, item.name, outlet, stockQty);
            }
          });
        });
      });
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return {
      id: reportId,
      reportDate,
      filename,
      totalStock,
      totalItems,
      totalOutlets,
      totalMerks,
      updated: !!existing
    };
  }

  getAllDates() {
    const stmt = this.db.prepare(`
      SELECT id, report_date, filename, total_stock, total_items, total_outlets, total_merks, created_at
      FROM reports
      ORDER BY report_date DESC
    `);
    return stmt.all();
  }

  getReportByDate(reportDate) {
    const stmt = this.db.prepare(`
      SELECT id, report_date, filename, total_stock, total_items, total_outlets, total_merks, raw_json, created_at
      FROM reports
      WHERE report_date = ?
    `);
    const row = stmt.get(reportDate);
    if (!row) return null;

    try {
      row.data = JSON.parse(row.raw_json);
      delete row.raw_json;
      return row;
    } catch (e) {
      console.error("Failed to parse report JSON", e);
      return null;
    }
  }

  deleteReportByDate(reportDate) {
    const row = this.db.prepare(`SELECT id FROM reports WHERE report_date = ?`).get(reportDate);
    if (!row) return false;

    this.db.prepare(`DELETE FROM stock_records WHERE report_id = ?`).run(row.id);
    this.db.prepare(`DELETE FROM reports WHERE id = ?`).run(row.id);
    return true;
  }

  // ==========================================
  // SALES BATCHES & RECORDS
  // ==========================================

  saveSalesBatch(batchDate, filename, parsedSales) {
    const now = new Date().toISOString();
    const existing = this.db.prepare(`SELECT id FROM sales_batches WHERE batch_date = ?`).get(batchDate);

    let batchId;
    if (existing) {
      batchId = existing.id;
      this.db.prepare(`
        UPDATE sales_batches
        SET filename = ?, total_rows = ?, total_qty = ?, total_amount = ?, total_profit = ?, total_outlets = ?, created_at = ?
        WHERE id = ?
      `).run(filename, parsedSales.totalRows, parsedSales.totalQty, parsedSales.totalAmount, parsedSales.totalProfit, parsedSales.uniqueOutlets.length, now, batchId);

      this.db.prepare(`DELETE FROM sales_records WHERE batch_id = ?`).run(batchId);
    } else {
      const insertBatch = this.db.prepare(`
        INSERT INTO sales_batches (batch_date, filename, total_rows, total_qty, total_amount, total_profit, total_outlets, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertBatch.run(batchDate, filename, parsedSales.totalRows, parsedSales.totalQty, parsedSales.totalAmount, parsedSales.totalProfit, parsedSales.uniqueOutlets.length, now);

      const newRow = this.db.prepare(`SELECT id FROM sales_batches WHERE batch_date = ?`).get(batchDate);
      batchId = newRow.id;
    }

    // Fast transaction insert for sales records
    this.db.exec('BEGIN TRANSACTION;');
    try {
      const insertRecord = this.db.prepare(`
        INSERT INTO sales_records (
          batch_id, transaction_no, transaction_date, transaction_time,
          outlet, customer, item_code, item_name, item_group,
          qty, unit, sell_price, discount, subtotal, cogs, profit_loss, cashier
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      parsedSales.records.forEach(r => {
        insertRecord.run(
          batchId, r.transactionNo, r.transactionDate, r.transactionTime,
          r.outlet, r.customer, r.itemCode, r.itemName, r.itemGroup,
          r.qty, r.unit, r.sellPrice, r.discount, r.subtotal, r.cogs, r.profitLoss, r.cashier
        );
      });
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return {
      id: batchId,
      batchDate,
      filename,
      totalRows: parsedSales.totalRows,
      totalQty: parsedSales.totalQty,
      totalAmount: parsedSales.totalAmount,
      totalProfit: parsedSales.totalProfit,
      totalOutlets: parsedSales.uniqueOutlets.length,
      updated: !!existing
    };
  }

  getAllSalesBatches() {
    const stmt = this.db.prepare(`
      SELECT id, batch_date, filename, total_rows, total_qty, total_amount, total_profit, total_outlets, created_at
      FROM sales_batches
      ORDER BY batch_date DESC
    `);
    return stmt.all();
  }

  deleteSalesBatch(batchDate) {
    const row = this.db.prepare(`SELECT id FROM sales_batches WHERE batch_date = ?`).get(batchDate);
    if (!row) return false;

    this.db.prepare(`DELETE FROM sales_records WHERE batch_id = ?`).run(row.id);
    this.db.prepare(`DELETE FROM sales_batches WHERE id = ?`).run(row.id);
    return true;
  }

  // ==========================================
  // PURCHASE BATCHES & RECORDS
  // ==========================================

  savePurchaseBatch(batchDate, filename, parsedPurchases) {
    const now = new Date().toISOString();
    const existing = this.db.prepare(`SELECT id FROM purchase_batches WHERE batch_date = ?`).get(batchDate);

    let batchId;
    if (existing) {
      batchId = existing.id;
      this.db.prepare(`
        UPDATE purchase_batches
        SET filename = ?, total_rows = ?, total_qty = ?, total_amount = ?, total_outlets = ?, created_at = ?
        WHERE id = ?
      `).run(filename, parsedPurchases.totalRows, parsedPurchases.totalQty, parsedPurchases.totalAmount, parsedPurchases.uniqueOutlets.length, now, batchId);

      this.db.prepare(`DELETE FROM purchase_records WHERE batch_id = ?`).run(batchId);
    } else {
      const insertBatch = this.db.prepare(`
        INSERT INTO purchase_batches (batch_date, filename, total_rows, total_qty, total_amount, total_outlets, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      insertBatch.run(batchDate, filename, parsedPurchases.totalRows, parsedPurchases.totalQty, parsedPurchases.totalAmount, parsedPurchases.uniqueOutlets.length, now);

      const newRow = this.db.prepare(`SELECT id FROM purchase_batches WHERE batch_date = ?`).get(batchDate);
      batchId = newRow.id;
    }

    this.db.exec('BEGIN TRANSACTION;');
    try {
      const insertRecord = this.db.prepare(`
        INSERT INTO purchase_records (
          batch_id, invoice_no, purchase_date, ref_invoice,
          outlet, vendor, item_code, item_name,
          qty, unit, unit_price, subtotal, total_invoice
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      parsedPurchases.records.forEach(r => {
        insertRecord.run(
          batchId, r.invoiceNo, r.purchaseDate, r.refInvoice,
          r.outlet, r.vendor, r.itemCode, r.itemName,
          r.qty, r.unit, r.unitPrice, r.subtotal, r.totalInvoice
        );
      });
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return {
      id: batchId,
      batchDate,
      filename,
      totalRows: parsedPurchases.totalRows,
      totalQty: parsedPurchases.totalQty,
      totalAmount: parsedPurchases.totalAmount,
      totalOutlets: parsedPurchases.uniqueOutlets.length,
      updated: !!existing
    };
  }

  getAllPurchaseBatches() {
    const stmt = this.db.prepare(`
      SELECT id, batch_date, filename, total_rows, total_qty, total_amount, total_outlets, created_at
      FROM purchase_batches
      ORDER BY batch_date DESC
    `);
    return stmt.all();
  }

  deletePurchaseBatch(batchDate) {
    const row = this.db.prepare(`SELECT id FROM purchase_batches WHERE batch_date = ?`).get(batchDate);
    if (!row) return false;

    this.db.prepare(`DELETE FROM purchase_records WHERE batch_id = ?`).run(row.id);
    this.db.prepare(`DELETE FROM purchase_batches WHERE id = ?`).run(row.id);
    return true;
  }

  // ==========================================
  // INTEGRATED ANALYTICS ENGINE QUERIES
  // ==========================================

  /**
   * Generates integrated data combining Current Stock, Sales, and Purchases.
   * @param {string} [stockDate] - Specific stock date or latest
   * @param {number} [daysWindow=1] - Days of sales to consider for ADS
   */
  getIntegratedData(stockDate, daysWindow = 1) {
    // 1. Pick stock date
    let targetStockDate = stockDate;
    if (!targetStockDate) {
      const latest = this.db.prepare(`SELECT report_date FROM reports ORDER BY report_date DESC LIMIT 1`).get();
      if (latest) targetStockDate = latest.report_date;
    }

    // 2. Fetch stock rows for target date
    const stockRows = targetStockDate
      ? this.db.prepare(`
          SELECT merk, item_code, item_name, outlet, stock 
          FROM stock_records 
          WHERE report_date = ?
        `).all(targetStockDate)
      : [];

    // 3. Fetch sales aggregation
    // If daysWindow is 1, take sales from latest sales date or all sales dates
    const salesDates = this.db.prepare(`SELECT DISTINCT transaction_date FROM sales_records ORDER BY transaction_date DESC`).all().map(r => r.transaction_date);
    const activeSalesDates = salesDates.slice(0, Math.max(1, daysWindow));
    
    let salesAgg = [];
    if (activeSalesDates.length > 0) {
      const placeholders = activeSalesDates.map(() => '?').join(',');
      salesAgg = this.db.prepare(`
        SELECT item_code, item_name, outlet, SUM(qty) as total_sold, SUM(subtotal) as total_amount, COUNT(DISTINCT transaction_date) as days_active
        FROM sales_records
        WHERE transaction_date IN (${placeholders})
        GROUP BY item_code, outlet
      `).all(...activeSalesDates);
    }

    // 4. Fetch purchase aggregation
    const purchAgg = this.db.prepare(`
      SELECT item_code, item_name, outlet, SUM(qty) as total_purchased, SUM(subtotal) as total_cost
      FROM purchase_records
      GROUP BY item_code, outlet
    `).all();

    // 5. Build merged map of items and outlets
    const itemsMap = {};
    const outletsSet = new Set();

    function ensureItem(code, name, merk) {
      if (!itemsMap[code]) {
        itemsMap[code] = {
          code,
          name: name || '',
          merk: merk || 'LAINNYA',
          totalStock: 0,
          totalSold: 0,
          totalPurchased: 0,
          outlets: {}
        };
      } else {
        if (!itemsMap[code].name && name) itemsMap[code].name = name;
        if (itemsMap[code].merk === 'LAINNYA' && merk) itemsMap[code].merk = merk;
      }
      return itemsMap[code];
    }

    function ensureOutlet(itemObj, outlet) {
      outletsSet.add(outlet);
      if (!itemObj.outlets[outlet]) {
        itemObj.outlets[outlet] = {
          stock: 0,
          sold: 0,
          purchased: 0,
          ads: 0,
          doc: Infinity,
          status: 'NO_DATA'
        };
      }
      return itemObj.outlets[outlet];
    }

    // Populate stock
    stockRows.forEach(r => {
      const item = ensureItem(r.item_code, r.item_name, r.merk);
      const out = ensureOutlet(item, r.outlet);
      out.stock = r.stock;
      item.totalStock += r.stock;
    });

    // Populate sales
    const numSalesDays = Math.max(1, activeSalesDates.length);
    salesAgg.forEach(r => {
      const item = ensureItem(r.item_code, r.item_name);
      const out = ensureOutlet(item, r.outlet);
      out.sold = r.total_sold;
      item.totalSold += r.total_sold;
      out.ads = +(r.total_sold / numSalesDays).toFixed(2);
    });

    // Populate purchases
    purchAgg.forEach(r => {
      const item = ensureItem(r.item_code, r.item_name);
      const out = ensureOutlet(item, r.outlet);
      out.purchased = r.total_purchased;
      item.totalPurchased += r.total_purchased;
    });

    // Compute Days of Coverage & Status for every item-outlet combo
    Object.values(itemsMap).forEach(item => {
      const itemADS = +(item.totalSold / numSalesDays).toFixed(2);
      item.totalADS = itemADS;
      item.globalDoC = itemADS > 0 ? +(item.totalStock / itemADS).toFixed(1) : (item.totalStock > 0 ? 999 : 0);

      Object.entries(item.outlets).forEach(([outlet, out]) => {
        if (out.ads > 0) {
          out.doc = +(out.stock / out.ads).toFixed(1);
          if (out.stock === 0) {
            out.status = 'OUT_OF_STOCK'; // 0 stock but selling!
          } else if (out.doc < 2) {
            out.status = 'CRITICAL';
          } else if (out.doc < 5) {
            out.status = 'WARNING';
          } else if (out.doc <= 14) {
            out.status = 'OPTIMAL';
          } else {
            out.status = 'OVERSTOCK';
          }
        } else {
          // No sales in this window
          if (out.stock > 0) {
            out.doc = 999;
            out.status = 'DEAD_STOCK'; // Holding stock, zero velocity
          } else {
            out.doc = 0;
            out.status = 'EMPTY';
          }
        }
      });
    });

    return {
      stockDate: targetStockDate,
      salesDates: activeSalesDates,
      salesDaysCount: numSalesDays,
      totalItemsCount: Object.keys(itemsMap).length,
      allOutlets: Array.from(outletsSet),
      items: itemsMap
    };
  }

  // ==========================================
  // SYSTEM & MAINTENANCE
  // ==========================================

  getDatabaseInfo() {
    let fileSize = 0;
    try {
      if (fs.existsSync(this.dbPath)) {
        fileSize = fs.statSync(this.dbPath).size;
      }
    } catch (e) {
      console.warn("Could not read file size", e);
    }

    const totalReports = this.db.prepare(`SELECT COUNT(*) as count FROM reports`).get().count;
    const totalStockRecords = this.db.prepare(`SELECT COUNT(*) as count FROM stock_records`).get().count;
    const totalSalesBatches = this.db.prepare(`SELECT COUNT(*) as count FROM sales_batches`).get().count;
    const totalSalesRecords = this.db.prepare(`SELECT COUNT(*) as count FROM sales_records`).get().count;
    const totalPurchBatches = this.db.prepare(`SELECT COUNT(*) as count FROM purchase_batches`).get().count;
    const totalPurchRecords = this.db.prepare(`SELECT COUNT(*) as count FROM purchase_records`).get().count;

    const stockRange = this.db.prepare(`SELECT MIN(report_date) as firstDate, MAX(report_date) as latestDate FROM reports`).get();
    const salesRange = this.db.prepare(`SELECT MIN(batch_date) as firstDate, MAX(batch_date) as latestDate FROM sales_batches`).get();

    return {
      fileSizeBytes: fileSize,
      fileSizeFormatted: fileSize >= 1024 * 1024 ? (fileSize / (1024 * 1024)).toFixed(2) + ' MB' : (fileSize / 1024).toFixed(1) + ' KB',
      totalReports,
      totalStockRecords,
      totalSalesBatches,
      totalSalesRecords,
      totalPurchBatches,
      totalPurchRecords,
      totalRecords: totalStockRecords + totalSalesRecords + totalPurchRecords,
      stockRange: {
        first: stockRange.firstDate || '-',
        latest: stockRange.latestDate || '-'
      },
      salesRange: {
        first: salesRange.firstDate || '-',
        latest: salesRange.latestDate || '-'
      },
      dbPath: this.dbPath
    };
  }

  clearAllData() {
    this.db.exec(`
      DELETE FROM stock_records;
      DELETE FROM reports;
      DELETE FROM sales_records;
      DELETE FROM sales_batches;
      DELETE FROM purchase_records;
      DELETE FROM purchase_batches;
      VACUUM;
    `);
    return true;
  }

  close() {
    this.db.close();
  }
}

module.exports = StockDatabase;
