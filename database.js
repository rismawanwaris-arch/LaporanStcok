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

    this.backupDatabase();

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

    this.backupDatabase();

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

    this.backupDatabase();

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
    const itemGroupMap = this.getItemGroupByCode();

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
          itemGroup: itemGroupMap[code] || 'LAINNYA',
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
      items: itemsMap,
      availableItemGroups: this.getDistinctItemGroups()
    };
  }

  /**
   * Analyzes recurring stockouts over a rolling window of daily stock reports,
   * cross-referenced with sales velocity, to surface items that sell well but
   * are chronically out of stock ("habit" tracking across daily uploads).
   *
   * Note: stock_records only stores rows where stock > 0 (see saveReport), so a
   * report_date with no row for a given item+outlet is treated as a 0-stock day
   * for that item+outlet — valid as long as the daily CSV export always lists
   * every item in a merk section (Bee Accounting exports do), even at 0 stock.
   *
   * @param {number} [days=30] - How many of the most recent daily stock reports to include
   * @param {number} [chronicThresholdPct=20] - Min avg stockout rate (%) to flag an item as "chronic"
   */
  /**
   * Maps item_code -> item_group ("VOUCHER", "PETSHOP", "ACC CAMPURAN NEW",
   * etc.) from sales history. Only sales_records carries this category field
   * (stock/purchase imports don't), so items never sold have no known group.
   */
  getItemGroupByCode() {
    const rows = this.db.prepare(`
      SELECT item_code, item_group FROM sales_records
      WHERE item_group IS NOT NULL AND item_group != ''
      GROUP BY item_code
    `).all();
    const map = {};
    rows.forEach(r => { map[r.item_code] = r.item_group; });
    return map;
  }

  /** Distinct item_group values seen in sales history, for populating category filters. */
  getDistinctItemGroups() {
    return this.db.prepare(`
      SELECT DISTINCT item_group FROM sales_records
      WHERE item_group IS NOT NULL AND item_group != ''
      ORDER BY item_group
    `).all().map(r => r.item_group);
  }

  getStockoutHistory(days = 30, chronicThresholdPct = 20) {
    const reportDates = this.db.prepare(`
      SELECT report_date FROM reports ORDER BY report_date DESC LIMIT ?
    `).all(days).map(r => r.report_date).sort();

    if (reportDates.length === 0) {
      return { days, reportDatesCount: 0, dateRange: null, chronicThresholdPct, items: [], outletSummary: [], availableItemGroups: this.getDistinctItemGroups() };
    }

    const stockPlaceholders = reportDates.map(() => '?').join(',');

    const stockRows = this.db.prepare(`
      SELECT report_date, merk, item_code, item_name, outlet, stock
      FROM stock_records
      WHERE report_date IN (${stockPlaceholders})
    `).all(...reportDates);

    // Sales are uploaded on their own cadence, independent of stock report dates
    // (see getIntegratedData) — so the sales window is its own set of recent
    // transaction dates rather than reusing reportDates.
    const salesDates = this.db.prepare(`
      SELECT DISTINCT transaction_date FROM sales_records ORDER BY transaction_date DESC LIMIT ?
    `).all(days).map(r => r.transaction_date);
    const numSalesDays = Math.max(1, salesDates.length);

    let salesRows = [];
    if (salesDates.length > 0) {
      const salesPlaceholders = salesDates.map(() => '?').join(',');
      salesRows = this.db.prepare(`
        SELECT item_code, item_name, outlet, SUM(qty) as total_sold
        FROM sales_records
        WHERE transaction_date IN (${salesPlaceholders})
        GROUP BY item_code, outlet
      `).all(...salesDates);
    }

    const itemGroupMap = this.getItemGroupByCode();
    const totalWindowDays = reportDates.length;
    const itemMap = {}; // item_code -> { name, merk, outlets: { outlet -> Set(reportDatesInStock) }, totalSold }

    function ensureItem(code, name, merk) {
      if (!itemMap[code]) {
        itemMap[code] = { code, name: name || code, merk: merk || 'LAINNYA', outlets: {}, totalSold: 0 };
      } else if (!itemMap[code].name && name) {
        itemMap[code].name = name;
      }
      return itemMap[code];
    }

    stockRows.forEach(r => {
      const item = ensureItem(r.item_code, r.item_name, r.merk);
      if (!item.outlets[r.outlet]) item.outlets[r.outlet] = new Set();
      item.outlets[r.outlet].add(r.report_date);
    });

    salesRows.forEach(r => {
      const item = ensureItem(r.item_code, r.item_name, null);
      item.totalSold += r.total_sold;
      if (!item.outlets[r.outlet]) item.outlets[r.outlet] = new Set(); // sold here but never seen in stock_records -> 100% stockout
    });

    const outletTotals = {}; // outlet -> { totalStockoutDays, itemsAffected }

    const items = Object.values(itemMap).map(item => {
      const outletDetails = Object.entries(item.outlets).map(([outlet, dateSet]) => {
        const daysInStock = dateSet.size;
        const daysOutOfStock = totalWindowDays - daysInStock;
        const stockoutRate = +(daysOutOfStock / totalWindowDays * 100).toFixed(1);

        if (daysOutOfStock > 0) {
          if (!outletTotals[outlet]) outletTotals[outlet] = { outlet, totalStockoutDays: 0, itemsAffected: 0 };
          outletTotals[outlet].totalStockoutDays += daysOutOfStock;
          outletTotals[outlet].itemsAffected += 1;
        }

        return { outlet, daysInStock, daysOutOfStock, stockoutRate };
      }).sort((a, b) => b.daysOutOfStock - a.daysOutOfStock);

      const worstOutlet = outletDetails[0] || null;
      const avgStockoutRate = outletDetails.length > 0
        ? +(outletDetails.reduce((s, o) => s + o.stockoutRate, 0) / outletDetails.length).toFixed(1)
        : 0;
      const ads = +(item.totalSold / numSalesDays).toFixed(2);
      // Chronic problem score: only meaningful for items that actually sell —
      // rewards items that are both fast-moving AND frequently unavailable.
      const problemScore = +(ads * avgStockoutRate).toFixed(2);
      const isChronic = ads > 0 && avgStockoutRate >= chronicThresholdPct;

      return {
        code: item.code,
        name: item.name,
        merk: item.merk,
        itemGroup: itemGroupMap[item.code] || 'LAINNYA',
        totalSold: item.totalSold,
        ads,
        avgStockoutRate,
        maxDaysOutOfStock: worstOutlet ? worstOutlet.daysOutOfStock : 0,
        worstOutlet: worstOutlet ? worstOutlet.outlet : '-',
        outletDetails,
        problemScore,
        isChronic
      };
    });

    items.sort((a, b) => b.problemScore - a.problemScore);

    const outletSummary = Object.values(outletTotals).sort((a, b) => b.totalStockoutDays - a.totalStockoutDays);

    return {
      days,
      reportDatesCount: totalWindowDays,
      salesDatesCount: salesDates.length,
      dateRange: { first: reportDates[0], latest: reportDates[reportDates.length - 1] },
      chronicThresholdPct,
      items,
      outletSummary,
      availableItemGroups: this.getDistinctItemGroups()
    };
  }

  /**
   * ABC classification (revenue Pareto: A ≈ top 80% cumulative, B ≈ next 15%,
   * C ≈ last 5%) crossed with stock aging (days since last sale) for every
   * item that currently has stock on hand — surfaces both "important item
   * running low" and "dead stock tying up capital" in one report.
   *
   * @param {number} [days=90] - Sales window used to rank items for ABC classification
   */
  getABCAgingAnalysis(days = 90) {
    const latest = this.db.prepare(`SELECT report_date FROM reports ORDER BY report_date DESC LIMIT 1`).get();
    if (!latest) {
      return { days, latestStockDate: null, items: [], availableItemGroups: this.getDistinctItemGroups() };
    }
    const latestStockDate = latest.report_date;
    const itemGroupMap = this.getItemGroupByCode();

    const currentStockRows = this.db.prepare(`
      SELECT merk, item_code, item_name, SUM(stock) as total_stock
      FROM stock_records
      WHERE report_date = ?
      GROUP BY item_code
      HAVING total_stock > 0
    `).all(latestStockDate);

    const salesDates = this.db.prepare(`
      SELECT DISTINCT transaction_date FROM sales_records ORDER BY transaction_date DESC LIMIT ?
    `).all(days).map(r => r.transaction_date);

    let salesInWindow = [];
    if (salesDates.length > 0) {
      const placeholders = salesDates.map(() => '?').join(',');
      salesInWindow = this.db.prepare(`
        SELECT item_code, SUM(subtotal) as revenue, SUM(qty) as qty
        FROM sales_records
        WHERE transaction_date IN (${placeholders})
        GROUP BY item_code
      `).all(...salesDates);
    }

    const lastSaleRows = this.db.prepare(`
      SELECT item_code, MAX(transaction_date) as last_sale_date, AVG(sell_price) as avg_sell_price
      FROM sales_records
      GROUP BY item_code
    `).all();
    const lastSaleMap = {};
    lastSaleRows.forEach(r => { lastSaleMap[r.item_code] = r; });

    const revenueMap = {};
    let totalRevenue = 0;
    salesInWindow.forEach(r => {
      revenueMap[r.item_code] = { revenue: r.revenue || 0, qty: r.qty || 0 };
      totalRevenue += (r.revenue || 0);
    });

    // Rank only items that actually generated revenue in the window, for a proper Pareto split
    const ranked = currentStockRows
      .map(r => ({ code: r.item_code, revenue: (revenueMap[r.item_code] || {}).revenue || 0 }))
      .filter(r => r.revenue > 0)
      .sort((a, b) => b.revenue - a.revenue);

    const abcClassMap = {};
    let cumulative = 0;
    ranked.forEach(r => {
      cumulative += r.revenue;
      const cumPct = totalRevenue > 0 ? (cumulative / totalRevenue) * 100 : 0;
      abcClassMap[r.code] = cumPct <= 80 ? 'A' : (cumPct <= 95 ? 'B' : 'C');
    });

    function daysBetween(a, b) {
      const d1 = new Date(a + 'T00:00:00Z').getTime();
      const d2 = new Date(b + 'T00:00:00Z').getTime();
      return Math.round((d1 - d2) / 86400000);
    }

    function agingBucketFor(agingDays, neverSold) {
      if (neverSold) return 'NEVER_SOLD';
      if (agingDays <= 30) return 'FRESH';
      if (agingDays <= 60) return 'AGING_30_60';
      if (agingDays <= 90) return 'AGING_60_90';
      return 'DEAD_STOCK';
    }

    const items = currentStockRows.map(r => {
      const saleInfo = lastSaleMap[r.item_code];
      const neverSold = !saleInfo || !saleInfo.last_sale_date;
      const agingDays = neverSold ? null : daysBetween(latestStockDate, saleInfo.last_sale_date);
      const avgSellPrice = saleInfo && saleInfo.avg_sell_price ? saleInfo.avg_sell_price : 0;
      const revenueInWindow = (revenueMap[r.item_code] || {}).revenue || 0;
      const qtyInWindow = (revenueMap[r.item_code] || {}).qty || 0;

      return {
        code: r.item_code,
        name: r.item_name,
        merk: r.merk,
        itemGroup: itemGroupMap[r.item_code] || 'LAINNYA',
        currentStock: r.total_stock,
        abcClass: abcClassMap[r.item_code] || '-',
        revenueInWindow: Math.round(revenueInWindow),
        qtyInWindow,
        lastSaleDate: neverSold ? null : saleInfo.last_sale_date,
        neverSold,
        agingDays: neverSold ? null : Math.max(0, agingDays),
        agingBucket: agingBucketFor(agingDays, neverSold),
        estimatedValue: Math.round(r.total_stock * avgSellPrice)
      };
    });

    // Worst-first: dead stock and never-sold items with the highest tied-up value surface first
    items.sort((a, b) => {
      const rank = { NEVER_SOLD: 0, DEAD_STOCK: 1, AGING_60_90: 2, AGING_30_60: 3, FRESH: 4 };
      if (rank[a.agingBucket] !== rank[b.agingBucket]) return rank[a.agingBucket] - rank[b.agingBucket];
      return b.estimatedValue - a.estimatedValue;
    });

    return { days, latestStockDate, totalRevenue: Math.round(totalRevenue), items, availableItemGroups: this.getDistinctItemGroups() };
  }

  /**
   * Ranks outlets by sales performance over a window, cross-referenced with
   * current stock levels and how often their assortment was out of stock in
   * the same window — surfaces both top performers and branches needing help.
   *
   * @param {number} [days=30]
   * @param {string} [itemGroup] - Optional category filter (e.g. "VOUCHER", "PETSHOP").
   *   Only applies to the sales-side numbers — stock and stockout rate aren't
   *   category-aware since that field only exists on sales_records.
   */
  getOutletPerformance(days = 30, itemGroup = null) {
    const salesDates = this.db.prepare(`
      SELECT DISTINCT transaction_date FROM sales_records ORDER BY transaction_date DESC LIMIT ?
    `).all(days).map(r => r.transaction_date);

    let salesRows = [];
    if (salesDates.length > 0) {
      const placeholders = salesDates.map(() => '?').join(',');
      const groupClause = itemGroup ? 'AND item_group = ?' : '';
      const params = itemGroup ? [...salesDates, itemGroup] : salesDates;
      salesRows = this.db.prepare(`
        SELECT outlet, SUM(subtotal) as revenue, SUM(profit_loss) as profit, SUM(qty) as qty,
               COUNT(DISTINCT transaction_no) as tx_count
        FROM sales_records
        WHERE transaction_date IN (${placeholders}) ${groupClause}
        GROUP BY outlet
      `).all(...params);
    }

    const latest = this.db.prepare(`SELECT report_date FROM reports ORDER BY report_date DESC LIMIT 1`).get();
    let stockRows = [];
    if (latest) {
      stockRows = this.db.prepare(`
        SELECT outlet, SUM(stock) as total_stock, COUNT(DISTINCT item_code) as item_count
        FROM stock_records
        WHERE report_date = ?
        GROUP BY outlet
      `).all(latest.report_date);
    }

    // Stockout rate per outlet: reuses the same "no stock_records row on a
    // report date = 0 stock that day" assumption as getStockoutHistory, but
    // aggregated by outlet instead of by item.
    const reportDates = this.db.prepare(`
      SELECT report_date FROM reports ORDER BY report_date DESC LIMIT ?
    `).all(days).map(r => r.report_date);
    let stockoutRows = [];
    if (reportDates.length > 0) {
      const placeholders = reportDates.map(() => '?').join(',');
      stockoutRows = this.db.prepare(`
        SELECT report_date, outlet, item_code FROM stock_records WHERE report_date IN (${placeholders})
      `).all(...reportDates);
    }
    const outletItemDays = {}; // outlet -> item_code -> Set(reportDatesInStock)
    stockoutRows.forEach(r => {
      if (!outletItemDays[r.outlet]) outletItemDays[r.outlet] = {};
      if (!outletItemDays[r.outlet][r.item_code]) outletItemDays[r.outlet][r.item_code] = new Set();
      outletItemDays[r.outlet][r.item_code].add(r.report_date);
    });
    const totalWindowDays = Math.max(1, reportDates.length);
    const stockoutRateByOutlet = {};
    Object.entries(outletItemDays).forEach(([outlet, items]) => {
      const rates = Object.values(items).map(dateSet => (totalWindowDays - dateSet.size) / totalWindowDays * 100);
      stockoutRateByOutlet[outlet] = rates.length > 0 ? +(rates.reduce((s, v) => s + v, 0) / rates.length).toFixed(1) : 0;
    });

    const outletMap = {};
    function ensureOutlet(name) {
      if (!outletMap[name]) {
        outletMap[name] = { outlet: name, revenue: 0, profit: 0, qty: 0, txCount: 0, currentStock: 0, itemCount: 0, stockoutRate: 0 };
      }
      return outletMap[name];
    }
    salesRows.forEach(r => {
      const o = ensureOutlet(r.outlet);
      o.revenue = r.revenue || 0;
      o.profit = r.profit || 0;
      o.qty = r.qty || 0;
      o.txCount = r.tx_count || 0;
    });
    stockRows.forEach(r => {
      const o = ensureOutlet(r.outlet);
      o.currentStock = r.total_stock || 0;
      o.itemCount = r.item_count || 0;
    });
    Object.entries(stockoutRateByOutlet).forEach(([outlet, rate]) => {
      ensureOutlet(outlet).stockoutRate = rate;
    });

    const totalNetworkRevenue = Object.values(outletMap).reduce((s, o) => s + o.revenue, 0);

    const outlets = Object.values(outletMap).map(o => ({
      ...o,
      revenueSharePct: totalNetworkRevenue > 0 ? +((o.revenue / totalNetworkRevenue) * 100).toFixed(1) : 0
    }));

    outlets.sort((a, b) => b.revenue - a.revenue);
    outlets.forEach((o, idx) => { o.rank = idx + 1; });

    // "Perlu Perhatian": bottom half of the network by revenue AND above-average stockout rate
    const avgStockoutRate = outlets.length > 0 ? outlets.reduce((s, o) => s + o.stockoutRate, 0) / outlets.length : 0;
    const medianRank = outlets.length / 2;
    outlets.forEach(o => {
      o.needsAttention = o.rank > medianRank && o.stockoutRate > avgStockoutRate;
    });

    return {
      days,
      itemGroup: itemGroup || null,
      salesDatesCount: salesDates.length,
      totalNetworkRevenue: Math.round(totalNetworkRevenue),
      avgStockoutRate: +avgStockoutRate.toFixed(1),
      outlets,
      availableItemGroups: this.getDistinctItemGroups()
    };
  }

  /**
   * Summarizes vendor spend and cross-vendor price competitiveness from
   * purchase history. Delivery lead time isn't tracked in the source data
   * (only an invoice/purchase date is recorded), so "fastest vendor" isn't
   * derivable — this focuses on what the data actually supports: spend,
   * purchase frequency, and per-item price comparison across vendors.
   *
   * @param {number} [days=90]
   */
  getVendorAnalysis(days = 90) {
    const purchDates = this.db.prepare(`
      SELECT DISTINCT purchase_date FROM purchase_records ORDER BY purchase_date DESC LIMIT ?
    `).all(days).map(r => r.purchase_date);

    if (purchDates.length === 0) {
      return { days, vendors: [] };
    }

    const placeholders = purchDates.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT vendor, item_code, item_name, invoice_no, purchase_date, qty, unit_price, subtotal
      FROM purchase_records
      WHERE purchase_date IN (${placeholders}) AND vendor IS NOT NULL AND vendor != ''
    `).all(...purchDates);

    const vendorMap = {};
    // itemVendorPrices: item_code -> vendor -> { totalQty, totalSpend } (for avg unit price per vendor per item)
    const itemVendorPrices = {};

    rows.forEach(r => {
      if (!vendorMap[r.vendor]) {
        vendorMap[r.vendor] = { vendor: r.vendor, totalSpend: 0, totalQty: 0, invoices: new Set(), items: new Set(), lastPurchaseDate: r.purchase_date };
      }
      const v = vendorMap[r.vendor];
      v.totalSpend += r.subtotal || 0;
      v.totalQty += r.qty || 0;
      if (r.invoice_no) v.invoices.add(r.invoice_no);
      v.items.add(r.item_code);
      if (r.purchase_date > v.lastPurchaseDate) v.lastPurchaseDate = r.purchase_date;

      if (!itemVendorPrices[r.item_code]) itemVendorPrices[r.item_code] = {};
      if (!itemVendorPrices[r.item_code][r.vendor]) {
        itemVendorPrices[r.item_code][r.vendor] = { totalQty: 0, totalSpend: 0, itemName: r.item_name };
      }
      itemVendorPrices[r.item_code][r.vendor].totalQty += r.qty || 0;
      itemVendorPrices[r.item_code][r.vendor].totalSpend += r.subtotal || 0;
    });

    // For each item purchased from 2+ vendors, find the cheapest vendor by avg unit price
    const cheapestVendorCountByVendor = {}; // vendor -> count of items where they're the cheapest
    const priceGapItems = []; // items where price spread between vendors is significant
    Object.entries(itemVendorPrices).forEach(([itemCode, vendorPrices]) => {
      const entries = Object.entries(vendorPrices).map(([vendor, v]) => ({
        vendor,
        itemName: v.itemName,
        avgUnitPrice: v.totalQty > 0 ? v.totalSpend / v.totalQty : 0
      })).filter(e => e.avgUnitPrice > 0);

      if (entries.length < 2) return; // only one vendor supplies this item — no comparison possible

      entries.sort((a, b) => a.avgUnitPrice - b.avgUnitPrice);
      const cheapest = entries[0];
      const priciest = entries[entries.length - 1];
      cheapestVendorCountByVendor[cheapest.vendor] = (cheapestVendorCountByVendor[cheapest.vendor] || 0) + 1;

      const spreadPct = cheapest.avgUnitPrice > 0 ? ((priciest.avgUnitPrice - cheapest.avgUnitPrice) / cheapest.avgUnitPrice) * 100 : 0;
      if (spreadPct >= 10) {
        priceGapItems.push({
          itemCode, itemName: cheapest.itemName,
          cheapestVendor: cheapest.vendor, cheapestPrice: Math.round(cheapest.avgUnitPrice),
          priciestVendor: priciest.vendor, priciestPrice: Math.round(priciest.avgUnitPrice),
          spreadPct: Math.round(spreadPct)
        });
      }
    });

    const vendors = Object.values(vendorMap).map(v => ({
      vendor: v.vendor,
      totalSpend: Math.round(v.totalSpend),
      totalQty: v.totalQty,
      invoiceCount: v.invoices.size,
      itemsSuppliedCount: v.items.size,
      lastPurchaseDate: v.lastPurchaseDate,
      cheapestOnCount: cheapestVendorCountByVendor[v.vendor] || 0
    }));

    vendors.sort((a, b) => b.totalSpend - a.totalSpend);
    priceGapItems.sort((a, b) => b.spreadPct - a.spreadPct);

    return { days, vendors, priceGapItems: priceGapItems.slice(0, 50) };
  }

  /**
   * Groups the full sales + purchase history into fixed-size day buckets
   * (or real calendar months) so trends across the daily uploads become
   * visible — e.g. "is this week's revenue up or down from last week".
   *
   * @param {string} [bucketType='week'] - 'day' | '3day' | 'week' | '2week' | 'month'
   * @param {string} [itemGroup] - Optional category filter (e.g. "VOUCHER"). Only
   *   applies to the sales side — purchase_records has no category field, so
   *   purchase totals are omitted entirely (not just left unfiltered, which
   *   would misleadingly compare "this category's sales" to "all purchases").
   */
  getTrendAnalysis(bucketType = 'week', itemGroup = null) {
    const salesGroupClause = itemGroup ? 'WHERE item_group = ?' : '';
    const salesByDay = this.db.prepare(`
      SELECT transaction_date as date, SUM(subtotal) as revenue, SUM(qty) as qty, SUM(profit_loss) as profit
      FROM sales_records ${salesGroupClause} GROUP BY transaction_date
    `).all(...(itemGroup ? [itemGroup] : []));

    const purchByDay = itemGroup ? [] : this.db.prepare(`
      SELECT purchase_date as date, SUM(subtotal) as amount, SUM(qty) as qty
      FROM purchase_records GROUP BY purchase_date
    `).all();

    const dayMap = {};
    function ensureDay(date) {
      if (!dayMap[date]) dayMap[date] = { revenue: 0, qty: 0, profit: 0, purchAmount: 0, purchQty: 0 };
      return dayMap[date];
    }
    salesByDay.forEach(r => {
      const d = ensureDay(r.date);
      d.revenue += r.revenue || 0;
      d.qty += r.qty || 0;
      d.profit += r.profit || 0;
    });
    purchByDay.forEach(r => {
      const d = ensureDay(r.date);
      d.purchAmount += r.amount || 0;
      d.purchQty += r.qty || 0;
    });

    const allDates = Object.keys(dayMap).sort();
    if (allDates.length === 0) {
      return { bucketType, itemGroup: itemGroup || null, purchaseDataAvailable: !itemGroup, buckets: [], availableItemGroups: this.getDistinctItemGroups() };
    }

    function newBucket(startDate) {
      return { startDate, endDate: startDate, days: 0, revenue: 0, qty: 0, profit: 0, purchAmount: 0, purchQty: 0 };
    }
    function addDayToBucket(bucket, date) {
      const d = dayMap[date];
      bucket.endDate = date;
      bucket.days += 1;
      bucket.revenue += d.revenue;
      bucket.qty += d.qty;
      bucket.profit += d.profit;
      bucket.purchAmount += d.purchAmount;
      bucket.purchQty += d.purchQty;
    }

    const buckets = [];
    if (bucketType === 'month') {
      const monthMap = {};
      const monthOrder = [];
      allDates.forEach(date => {
        const monthKey = date.slice(0, 7); // YYYY-MM
        if (!monthMap[monthKey]) {
          monthMap[monthKey] = newBucket(date);
          monthMap[monthKey].label = monthKey;
          monthOrder.push(monthKey);
        }
        addDayToBucket(monthMap[monthKey], date);
      });
      monthOrder.forEach(k => buckets.push(monthMap[k]));
    } else {
      const bucketSizeDays = { day: 1, '3day': 3, week: 7, '2week': 14 }[bucketType] || 7;
      const firstDateMs = new Date(allDates[0] + 'T00:00:00Z').getTime();
      const bucketByIndex = {};
      const indexOrder = [];
      allDates.forEach(date => {
        const daysSinceStart = Math.floor((new Date(date + 'T00:00:00Z').getTime() - firstDateMs) / 86400000);
        const idx = Math.floor(daysSinceStart / bucketSizeDays);
        if (!bucketByIndex[idx]) {
          bucketByIndex[idx] = newBucket(date);
          indexOrder.push(idx);
        }
        addDayToBucket(bucketByIndex[idx], date);
      });
      indexOrder.sort((a, b) => a - b).forEach(idx => {
        const b = bucketByIndex[idx];
        b.label = b.startDate === b.endDate ? b.startDate : `${b.startDate} s/d ${b.endDate}`;
        buckets.push(b);
      });
    }

    buckets.forEach(b => {
      b.revenue = Math.round(b.revenue);
      b.profit = Math.round(b.profit);
      b.purchAmount = Math.round(b.purchAmount);
    });

    return {
      bucketType,
      itemGroup: itemGroup || null,
      purchaseDataAvailable: !itemGroup,
      dateRange: { first: allDates[0], last: allDates[allDates.length - 1] },
      buckets,
      availableItemGroups: this.getDistinctItemGroups()
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

    let backupCount = 0;
    let latestBackupAt = null;
    try {
      const backupDir = path.join(path.dirname(this.dbPath), 'backups');
      if (fs.existsSync(backupDir)) {
        const files = fs.readdirSync(backupDir).filter(f => f.startsWith('stock_history_') && f.endsWith('.db')).sort();
        backupCount = files.length;
        if (files.length > 0) {
          latestBackupAt = fs.statSync(path.join(backupDir, files[files.length - 1])).mtime.toISOString();
        }
      }
    } catch (e) {
      console.warn('Could not read backup folder info', e);
    }

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
      dbPath: this.dbPath,
      autoBackup: {
        count: backupCount,
        latestAt: latestBackupAt
      }
    };
  }

  /**
   * Copies the live .db file into a `backups/` subfolder next to it, keeping
   * only the most recent MAX_BACKUPS copies. Runs after every successful
   * upload (and before a destructive clear) so a recent restore point always
   * sits inside the same persistent volume as the live database — this
   * guards against accidental deletion/corruption, not against the volume
   * itself being unmounted or missing (see README for the ZimaOS volume
   * mapping that persistence actually depends on).
   */
  backupDatabase() {
    const MAX_BACKUPS = 14;
    try {
      if (!fs.existsSync(this.dbPath)) return;

      const backupDir = path.join(path.dirname(this.dbPath), 'backups');
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(backupDir, `stock_history_${timestamp}.db`);
      fs.copyFileSync(this.dbPath, backupPath);

      const files = fs.readdirSync(backupDir)
        .filter(f => f.startsWith('stock_history_') && f.endsWith('.db'))
        .sort(); // ISO-formatted names sort chronologically
      if (files.length > MAX_BACKUPS) {
        files.slice(0, files.length - MAX_BACKUPS).forEach(f => {
          fs.unlinkSync(path.join(backupDir, f));
        });
      }
    } catch (err) {
      // Never let a backup failure break the actual save that triggered it
      console.warn('[Backup] Gagal membuat cadangan otomatis:', err.message);
    }
  }

  clearAllData() {
    this.backupDatabase(); // safety snapshot right before a destructive wipe
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
