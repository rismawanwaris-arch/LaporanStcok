/**
 * Stock Analytics Helper
 * Provides data processing and statistical analysis for stock data.
 */

class StockAnalytics {
  /**
   * Calculates overall summaries for each Merk.
   * @param {Object} parsedData - The parsed data from StockDataParser
   * @returns {Object} Summaries per Merk and global overview
   */
  static getOverview(parsedData) {
    const summary = {
      global: {
        totalStock: 0,
        totalItems: Object.keys(parsedData.allItems).length,
        totalOutlets: parsedData.allOutlets.length,
        totalMerks: Object.keys(parsedData.merks).length
      },
      merks: {}
    };

    for (const [merkName, merkData] of Object.entries(parsedData.merks)) {
      let totalMerkStock = 0;
      const itemsList = Object.values(merkData.items);
      const itemCount = itemsList.length;

      // Calculate totals
      itemsList.forEach(item => {
        Object.values(item.stocks).forEach(stock => {
          totalMerkStock += stock;
        });
      });

      summary.global.totalStock += totalMerkStock;

      summary.merks[merkName] = {
        name: merkName,
        totalStock: totalMerkStock,
        totalItems: itemCount,
        totalOutlets: merkData.outlets.length
      };
    }

    return summary;
  }

  /**
   * Calculates totals and details for each outlet under a specific Merk.
   * @param {Object} merkData - The data of a single Merk
   * @returns {Array} List of outlets with calculated statistics
   */
  static getOutletStatistics(merkData) {
    const outletStats = {};

    // Initialize all outlets for this Merk
    merkData.outlets.forEach(outlet => {
      outletStats[outlet] = {
        name: outlet,
        totalStock: 0,
        itemCount: 0,
        lowStockCount: 0
      };
    });

    const items = Object.values(merkData.items);
    items.forEach(item => {
      for (const [outletName, stock] of Object.entries(item.stocks)) {
        if (outletStats[outletName]) {
          outletStats[outletName].totalStock += stock;
          if (stock > 0) {
            outletStats[outletName].itemCount++;
          }
          if (stock > 0 && stock <= 3) { // Low stock threshold: 3 PCS
            outletStats[outletName].lowStockCount++;
          }
        }
      }
    });

    return Object.values(outletStats).sort((a, b) => b.totalStock - a.totalStock);
  }

  /**
   * Identifies top stock items and low stock items.
   * @param {Object} merkData 
   * @param {number} lowThreshold 
   * @returns {Object} { topItems, lowStockItems }
   */
  static getItemStatistics(merkData, lowThreshold = 3) {
    const itemStats = [];

    Object.values(merkData.items).forEach(item => {
      let totalStock = 0;
      let outletsWithStock = 0;
      const lowStockOutlets = [];

      for (const [outletName, stock] of Object.entries(item.stocks)) {
        totalStock += stock;
        if (stock > 0) {
          outletsWithStock++;
          if (stock <= lowThreshold) {
            lowStockOutlets.push({ outlet: outletName, stock: stock });
          }
        }
      }

      itemStats.push({
        code: item.code,
        name: item.name,
        totalStock: totalStock,
        activeOutlets: outletsWithStock,
        lowStockDetails: lowStockOutlets
      });
    });

    // Sort by total stock descending
    const sorted = [...itemStats].sort((a, b) => b.totalStock - a.totalStock);

    return {
      allItems: sorted,
      topItems: sorted.slice(0, 5),
      lowStockItems: itemStats.filter(item => item.lowStockDetails.length > 0)
    };
  }
}

// Export or attach to window
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StockAnalytics;
} else {
  window.StockAnalytics = StockAnalytics;
}
