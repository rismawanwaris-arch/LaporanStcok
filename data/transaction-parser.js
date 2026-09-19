/**
 * Transaction Parser for Bee Accounting Sales and Purchase reports.
 * Supports Excel binary (.xls / .xlsx) and CSV files using SheetJS.
 */

const XLSX = require('xlsx');
const StockDataParser = require('./stock-data');

class TransactionParser {
  /**
   * Converts Excel date serial number or text to YYYY-MM-DD.
   * @param {number|string} val
   * @returns {string} YYYY-MM-DD
   */
  static parseDate(val) {
    if (!val) {
      return new Date().toISOString().split('T')[0];
    }

    if (typeof val === 'number') {
      // Excel serial date to JS Date
      // Excel base date: Dec 30, 1899
      const utcDays = Math.floor(val - 25569);
      const utcValue = utcDays * 86400;
      const dateInfo = new Date(utcValue * 1000);
      const year = dateInfo.getUTCFullYear();
      const month = String(dateInfo.getUTCMonth() + 1).padStart(2, '0');
      const day = String(dateInfo.getUTCDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    const str = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      return str;
    }

    // Try DD/MM/YYYY or DD-MM-YYYY
    const dmyMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (dmyMatch) {
      const d = dmyMatch[1].padStart(2, '0');
      const m = dmyMatch[2].padStart(2, '0');
      const y = dmyMatch[3];
      return `${y}-${m}-${d}`;
    }

    // Fallback: try Date.parse
    const parsed = new Date(str);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString().split('T')[0];
    }

    return new Date().toISOString().split('T')[0];
  }

  /**
   * Loads SheetJS workbook from buffer or file path.
   * @param {Buffer|string} input 
   * @returns {Object} Workbook
   */
  static getWorkbook(input) {
    if (Buffer.isBuffer(input)) {
      return XLSX.read(input, { type: 'buffer' });
    }
    if (typeof input === 'string') {
      if (input.startsWith('data:') && input.includes(';base64,')) {
        const base64Data = input.split(';base64,')[1];
        const buffer = Buffer.from(base64Data, 'base64');
        return XLSX.read(buffer, { type: 'buffer' });
      }
      return XLSX.readFile(input);
    }
    throw new Error('Format input tidak didukung (harus berupa Buffer, path file, atau base64)');
  }

  /**
   * Automatically detects file report type based on sheet columns.
   * @param {Buffer|string} input 
   * @returns {'sales'|'purchases'|'stock'|'unknown'}
   */
  static detectType(input) {
    try {
      const wb = this.getWorkbook(input);
      const firstSheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
      if (!rows || rows.length === 0) return 'unknown';

      // Scan first 10 rows for signature column headers
      for (let r = 0; r < Math.min(10, rows.length); r++) {
        const rowStr = (rows[r] || []).join(' ').toLowerCase();
        if (rowStr.includes('no transaksi') || rowStr.includes('harga jual') || rowStr.includes('laba rugi')) {
          return 'sales';
        }
        if (rowStr.includes('no faktur') || rowStr.includes('vendor') || rowStr.includes('faktur ref')) {
          return 'purchases';
        }
        if (rowStr.includes('kode item') && (rowStr.includes('nama item') || rowStr.includes('total stock'))) {
          return 'stock';
        }
      }
      return 'unknown';
    } catch (e) {
      return 'unknown';
    }
  }

  /**
   * Parses Sales detail report (e.g. 14-09-2026.xls from Bee Accounting).
   * @param {Buffer|string} input 
   * @returns {Object} Parsed sales summary and records
   */
  static parseSales(input) {
    const wb = this.getWorkbook(input);
    let sheetName = wb.SheetNames.find(s => s.toLowerCase().includes('query') || s.toLowerCase().includes('sales')) || wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(ws);

    if (!rawRows || rawRows.length === 0) {
      throw new Error('Lembar kerja penjualan kosong atau tidak memiliki data.');
    }

    const records = [];
    const dateCounts = {};
    const outletsSet = new Set();
    let totalQty = 0;
    let totalAmount = 0;
    let totalProfit = 0;

    rawRows.forEach(row => {
      const txNo = String(row['No Transaksi'] || row['No. Transaksi'] || row['No Faktur'] || '').trim();
      const rawDate = row['Tanggal'] || row['Tgl'];
      const rawOutlet = String(row['Cabang'] || row['Outlet'] || '').trim();
      const rawItemCode = String(row['Kode Item'] || row['Kode Barang'] || '').trim();
      const rawItemName = String(row['Nama Item'] || row['Nama Barang'] || '').trim();

      if (!rawItemCode && !rawItemName) return;

      const txDate = this.parseDate(rawDate);
      dateCounts[txDate] = (dateCounts[txDate] || 0) + 1;

      const outlet = StockDataParser.normalizeOutletName(rawOutlet) || rawOutlet;
      if (outlet) outletsSet.add(outlet);
      const itemCode = StockDataParser.namespaceItemCode(rawItemCode, outlet);

      const qty = parseFloat(row['qty'] || row['Qty'] || row['Jumlah'] || 0) || 0;
      const unit = String(row['unit'] || row['Satuan'] || 'PCS').trim();
      const sellPrice = parseFloat(row['Harga Jual'] || row['Harga'] || 0) || 0;
      const discount = parseFloat(row['Diskon'] || 0) || 0;
      const subtotal = parseFloat(row['Subtotal'] || row['Total'] || (qty * sellPrice)) || 0;
      const cogs = parseFloat(row['HPP'] || 0) || 0;
      const profitLoss = parseFloat(row['Laba Rugi'] || (subtotal - (qty * cogs))) || 0;
      const itemGroup = String(row['Item Group'] || row['Grup Item'] || 'VOUCHER').trim();
      const customer = String(row['Customer'] || row['Pelanggan'] || '').trim();
      const cashier = String(row['Pegawai'] || row['Kasir'] || '').trim();
      const txTime = String(row['Jam Buat'] || row['Jam'] || '').trim();

      totalQty += qty;
      totalAmount += subtotal;
      totalProfit += profitLoss;

      records.push({
        transactionNo: txNo,
        transactionDate: txDate,
        transactionTime: txTime,
        outlet,
        customer,
        itemCode,
        itemName: rawItemName,
        itemGroup,
        qty: Math.round(qty),
        unit,
        sellPrice,
        discount,
        subtotal,
        cogs,
        profitLoss,
        cashier
      });
    });

    let primaryDate = new Date().toISOString().split('T')[0];
    let maxCount = 0;
    for (const [d, count] of Object.entries(dateCounts)) {
      if (count > maxCount) {
        maxCount = count;
        primaryDate = d;
      }
    }

    return {
      type: 'sales',
      batchDate: primaryDate,
      totalRows: records.length,
      totalQty: Math.round(totalQty),
      totalAmount: Math.round(totalAmount),
      totalProfit: Math.round(totalProfit),
      uniqueOutlets: Array.from(outletsSet),
      records
    };
  }

  /**
   * Parses Purchase detail report (e.g. DetailPembelian-*.xls from Bee Accounting).
   * @param {Buffer|string} input 
   * @returns {Object} Parsed purchases summary and records
   */
  static parsePurchases(input) {
    const wb = this.getWorkbook(input);
    let sheetName = wb.SheetNames.find(s => s.toLowerCase().includes('pembelian') || s.toLowerCase().includes('worksheet')) || wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(ws);

    if (!rawRows || rawRows.length === 0) {
      throw new Error('Lembar kerja pembelian kosong atau tidak memiliki data.');
    }

    const records = [];
    const dateCounts = {};
    const outletsSet = new Set();
    const vendorsSet = new Set();
    let totalQty = 0;
    let totalAmount = 0;

    rawRows.forEach(row => {
      const invoiceNo = String(row['No Faktur'] || row['No. Faktur'] || '').trim();
      const rawDate = row['Tanggal'] || row['Tgl'];
      const rawOutlet = String(row['Cabang'] || row['Outlet'] || 'GDG').trim();
      const rawItemCode = String(row['Kode Item'] || row['Kode Barang'] || '').trim();
      const rawItemName = String(row['Nama Item'] || row['Nama Barang'] || '').trim();

      if (!rawItemCode && !rawItemName) return;

      const purchaseDate = this.parseDate(rawDate);
      dateCounts[purchaseDate] = (dateCounts[purchaseDate] || 0) + 1;

      const outlet = StockDataParser.normalizeOutletName(rawOutlet) || rawOutlet;
      if (outlet) outletsSet.add(outlet);
      const itemCode = StockDataParser.namespaceItemCode(rawItemCode, outlet);

      const vendor = String(row['Vendor'] || row['Supplier'] || '').trim();
      if (vendor) vendorsSet.add(vendor);

      const qty = parseFloat(row['Qty'] || row['qty'] || row['Jumlah'] || 0) || 0;
      const unit = String(row['Satuan'] || row['unit'] || 'PCS').trim();
      const unitPrice = parseFloat(row['Harga'] || 0) || 0;
      const subtotal = parseFloat(row['Subtotal Item'] || row['Subtotal'] || (qty * unitPrice)) || 0;
      const totalInvoice = parseFloat(row['Total'] || subtotal) || subtotal;
      const refInvoice = String(row['Faktur Ref'] || '').trim();

      totalQty += qty;
      totalAmount += subtotal;

      records.push({
        invoiceNo,
        purchaseDate,
        refInvoice,
        outlet,
        vendor,
        itemCode,
        itemName: rawItemName,
        qty: Math.round(qty),
        unit,
        unitPrice,
        subtotal,
        totalInvoice
      });
    });

    let primaryDate = new Date().toISOString().split('T')[0];
    let maxCount = 0;
    for (const [d, count] of Object.entries(dateCounts)) {
      if (count > maxCount) {
        maxCount = count;
        primaryDate = d;
      }
    }

    return {
      type: 'purchases',
      batchDate: primaryDate,
      totalRows: records.length,
      totalQty: Math.round(totalQty),
      totalAmount: Math.round(totalAmount),
      uniqueOutlets: Array.from(outletsSet),
      uniqueVendors: Array.from(vendorsSet),
      records
    };
  }
}

module.exports = TransactionParser;
