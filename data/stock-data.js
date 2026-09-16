/**
 * Stock Data Parser for Bee Accounting Stock Report CSV.
 * Handles multi-section, column-wrapped tables, and duplicate outlet names.
 */

class StockDataParser {
  /**
   * Translates raw CSV outlet names to the user's preferred names.
   * @param {string} rawName - Raw outlet name from CSV
   * @param {number} occurrence - Occurrence index for duplicate names within a brand
   * @returns {string} Clean, normalized name
   */
  static normalizeOutletName(rawName, occurrence) {
    const name = rawName.trim();
    if (!name) return '';

    // Handle CILENGKRA duplicate naming specifically
    if (name === 'CILENGKRA') {
      if (occurrence === 2) return 'CILENGKRANG 2';
      if (occurrence === 3) return 'CILENGKRANG 3';
      if (occurrence === 4) return 'CILENGKRANG 4';
      if (occurrence === 5) return 'CILENGKRANG 5';
      if (occurrence === 6) return 'CILENGKRANG 6';
      return 'CILENGKRANG';
    }

    // Static mapping dictionary to translate CSV names to preferred names
    const map = {
      'Gudang': 'GDG',
      'GUDANG': 'GDG',
      'ALFA 1 (C)': 'ALFA 1',
      'ALFA 1 CELL': 'ALFA 1',
      'ALFA 2 (C)': 'ALFA 2',
      'ALFA 2 CELL': 'ALFA 2',
      'ALFA 3 (C)': 'ALFA 3',
      'ALFA 3 CELL': 'ALFA 3',
      'ALFA 4 (C)': 'ALFA 4',
      'ALFA 4 CELL': 'ALFA 4',
      'ALFA 5 (C)': 'ALFA 5',
      'ALFA 5 CELL': 'ALFA 5',
      'ALFA 6 (C)': 'ALFA 6',
      'ALFA 6 CELL': 'ALFA 6',
      'ALFA 7': 'ALFA 7',
      'ALFA 7 CINGISED': 'ALFA 7',
      'ASBER 1 (C)': 'ASBER 1 CELL',
      'ASBER 1 CELL': 'ASBER 1 CELL',
      'ASBER 2 (C)': 'ASBER 2 CELL',
      'ASBER 2 CELL': 'ASBER 2 CELL',
      'BK JH1': 'BK JH1 SINOM',
      'BK JH1 SINOM': 'BK JH1 SINOM',
      'BK JH2 (C)': 'BK JH2 JTHNDP BAWAH',
      'BK JH2 JTHNDP BAWAH': 'BK JH2 JTHNDP BAWAH',
      'BK8 BAKSAR': 'BK8 BAKSAR 1',
      'BK8 BAKSAR 1': 'BK8 BAKSAR 1',
      'BK9 BAKSAR': 'BK9 BAKSAR 2',
      'BK9 BAKSAR 2': 'BK9 BAKSAR 2',
      'CK (C)': 'CIKADUT CELL',
      'CIKADUT CELL': 'CIKADUT CELL',
      'CIKADUT 2': 'CIKADUT CELL 2',
      'CIKADUT CELL 2': 'CIKADUT CELL 2',
      'CISA (C)': 'CISA',
      'CISARANTEN CELL': 'CISA',
      'CICUKANG': 'CICUKANG',
      'CIHAURKUKU': 'CIHAURKUK',
      'CIHAURKUK': 'CIHAURKUK',
      'CILENGKRANG 1': 'CILENGKRANG',
      'CIPAGALO': 'CIPAGALO',
      'CIPAGALO CELL': 'CIPAGALO',
      'PD 1 (C)': 'PD 1',
      'PD 1 PADASUKA 1': 'PD 1',
      'PD 2 (C)': 'PD 2',
      'PD 2 PADASUKA 2': 'PD 2',
      'PD 3 (C)': 'PD 3',
      'PD 3 PADASUKA 3': 'PD 3',
      'BK CIJAMBE': 'BK CJMB',
      'BKC': 'BK CIPADUNG',
      'BK CIPADUNG': 'BK CIPADUNG',
      'CIPADUNG 2': 'BK CIPADUNG 2',
      'BK5 CIGER': 'BK 5 CIGER',
      'BK5 CIGER CELL': 'BK 5 CIGER',
      'BK 5 CIGER': 'BK 5 CIGER',
      'BK6': 'BK 6 PANGARITAN',
      'BK6 PANGARITAN': 'BK 6 PANGARITAN',
      'BK 6 PANGARITAN': 'BK 6 PANGARITAN',
      'BK7': 'BK 7 NAGROG',
      'BK7 NAGROG': 'BK 7 NAGROG',
      'BK 7 NAGROG': 'BK 7 NAGROG',
      // Stock report uses "CL n" column headers for these branches while the
      // sales/purchase reports spell them out as "CILENGKRANG"/"CILENGKRANG n"
      // (see TransactionParser, which reuses this same map). Without this,
      // joining stock+sales by outlet name treats them as 8 different branches
      // instead of the 4 physical Cilengkrang outlets.
      'CL 1': 'CILENGKRANG',
      'CL 2': 'CILENGKRANG 2',
      'CL 3': 'CILENGKRANG 3',
      'CL 4': 'CILENGKRANG 4',
      'BUNISARI': 'BUNISARI',
      'BUNISARI CELL': 'BUNISARI',
      'CIPOREAT': 'CIPOREAT',
      'DM (C)': 'DM',
      'DM CELL': 'DM',
      'PC 3 (A)': 'PC 3',
      'PC 3 CELL': 'PC 3',
      'PC 4 (C)': 'PC 4',
      'PC 4 CELL': 'PC 4',
      'PC 5 (C)': 'PC 5',
      'PC 5 CELL': 'PC 5',
      'RK (C)': 'RK',
      'RAJA KUOTA': 'RK',
      'SA (C)': 'SA',
      'SA SUKAASIH': 'SA',
      'SS (C)': 'SS',
      'SS SINDANG SARI': 'SS',
      'PETSHOP': 'PETSHOP'
    };

    return map[name] || name;
  }

  /**
   * Parses the raw CSV string into a structured JSON object.
   * @param {string} csvText 
   * @returns {Object} Structured stock data
   */
  static parse(csvText) {
    const lines = csvText.split(/\r?\n/);
    const result = {
      merks: {},       // Keyed by Merk name
      allOutlets: [],  // Global list of unique outlets in order of appearance
      allItems: {}     // Keyed by item code
    };

    let currentMerk = null;
    let currentOutletsInBlock = [];
    
    // To handle duplicate outlet names within a Merk
    let outletCounts = {};

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const cells = this.parseCSVLine(line);
      if (cells.length === 0) continue;

      // Detect Merk Section
      // Format: ,Merk,Model,,,,,,,
      // Next line: ,VOUCER AXIS,< kosong >,,,,,,,
      if (cells[1] === 'Merk' && cells[2] === 'Model') {
        // Read next line for the actual Merk name
        if (i + 1 < lines.length) {
          const nextCells = this.parseCSVLine(lines[i + 1]);
          if (nextCells[1] && nextCells[1] !== '< kosong >') {
            currentMerk = nextCells[1].trim();
            if (!result.merks[currentMerk]) {
              result.merks[currentMerk] = {
                name: currentMerk,
                items: {},
                outlets: [] // List of outlets for this Merk
              };
            }
            outletCounts = {}; // Reset duplicate detector for new Merk
          }
          i++; // Skip the next line as we just read it
        }
        continue;
      }

      // If we haven't found a Merk yet, skip
      if (!currentMerk) continue;

      // Detect Table Header (Outlet Columns)
      // Format: Kode Item,Nama Item,Outlet 1,Outlet 2,...
      if (cells[0] === 'Kode Item' && cells[1] === 'Nama Item') {
        currentOutletsInBlock = [];
        for (let c = 2; c < cells.length; c++) {
          const rawName = cells[c].trim();
          // Skip empty columns or total/metadata columns
          if (!rawName || rawName === 'TOTAL' || rawName === 'TOTAL STOCK') continue;
          
          // Track count of occurrences for rawName under this Merk
          if (!outletCounts[rawName]) {
            outletCounts[rawName] = 1;
          } else {
            outletCounts[rawName]++;
          }
          
          // Translate to preferred normalized name
          const uniqueName = this.normalizeOutletName(rawName, outletCounts[rawName]);

          currentOutletsInBlock.push(uniqueName);

          // Add to global outlets if not already present
          if (!result.allOutlets.includes(uniqueName)) {
            result.allOutlets.push(uniqueName);
          }

          // Add to current Merk outlets
          const merkObj = result.merks[currentMerk];
          if (!merkObj.outlets.includes(uniqueName)) {
            merkObj.outlets.push(uniqueName);
          }
        }
        continue;
      }

      // Detect Item Stock Row
      // Format: 6-digit item code (or similar), Nama Item, Stock 1, Stock 2...
      // Validate that cells[0] is an item code (typically numeric e.g. 001341)
      const itemCode = cells[0].trim();
      const itemName = cells[1] ? cells[1].trim() : '';
      
      if (itemCode && itemCode !== 'TOTAL' && itemCode !== 'Kode Item' && /^\d+$/.test(itemCode)) {
        const merkObj = result.merks[currentMerk];
        
        if (!merkObj.items[itemCode]) {
          merkObj.items[itemCode] = {
            code: itemCode,
            name: itemName,
            stocks: {} // outletName -> stockValue
          };
        }

        // Register globally
        if (!result.allItems[itemCode]) {
          result.allItems[itemCode] = itemName;
        }

        // Fill in stock values for current block outlets
        let colIndex = 2;
        for (let o = 0; o < currentOutletsInBlock.length; o++) {
          const outletName = currentOutletsInBlock[o];
          const stockStr = cells[colIndex] ? cells[colIndex].trim() : '0';
          // Extract number from e.g. "3 PCS" or "3.00"
          const stockVal = this.parseStockValue(stockStr);
          
          // Merge stocks if the outlet is repeated due to page wrapping
          if (merkObj.items[itemCode].stocks[outletName]) {
            // Only update if current value is 0 or we want to add them.
            // Note: repeated page wrap headers usually have no values or total row only.
            // But if there are actual stock rows, merge them by adding or keeping the max.
            // Since they are the same physical outlet, adding is correct if they are different items, 
            // but if they are the same item on different wrapped pages, it's the same cell so they should be identical.
            // Let's set it if not already set, or add them.
            if (stockVal > 0) {
              merkObj.items[itemCode].stocks[outletName] += stockVal;
            }
          } else {
            merkObj.items[itemCode].stocks[outletName] = stockVal;
          }
          colIndex++;
        }
      }
    }

    return result;
  }

  /**
   * Helper to parse a single CSV line, handling quotes correctly.
   */
  static parseCSVLine(line) {
    const result = [];
    let insideQuote = false;
    let currentCell = '';

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        insideQuote = !insideQuote;
      } else if (char === ',' && !insideQuote) {
        result.push(currentCell);
        currentCell = '';
      } else {
        currentCell += char;
      }
    }
    result.push(currentCell); // Push last cell
    return result;
  }

  /**
   * Helper to extract integer value from stock string (e.g., "3 PCS" -> 3)
   */
  static parseStockValue(str) {
    if (!str) return 0;
    // Remove " PCS", spaces, and parse
    const cleanStr = str.replace(/PCS/i, '').replace(/,/g, '').trim();
    const val = parseFloat(cleanStr);
    return isNaN(val) ? 0 : Math.round(val);
  }
}

// Export for ES modules or attach to window for simple browser use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StockDataParser;
} else {
  window.StockDataParser = StockDataParser;
}
