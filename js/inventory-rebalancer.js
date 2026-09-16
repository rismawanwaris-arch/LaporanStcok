/**
 * Smart Inventory Rebalancer & PO Planner Engine.
 * Calculates Days of Coverage (DoC), Inter-Branch Transfer Suggestions,
 * and Purchase Order (PO) Recommendations based on multi-outlet data.
 */

class InventoryRebalancer {
  /**
   * Generates Smart Inter-Branch Transfer Recommendations.
   * Finds branches with stockouts or critical levels and pairs them
   * with Gudang or overstocked branches.
   * 
   * @param {Object} integratedData - Output from StockDatabase.getIntegratedData()
   * @param {Object} [options]
   * @returns {Array<Object>} List of actionable transfer recommendations
   */
  static generateTransferRecommendations(integratedData, options = {}) {
    const targetDays = options.targetDays || 7;      // Target coverage days for receiver
    const minOverstockDays = options.minOverstockDays || 20; // Min days to consider sender overstocked

    const recommendations = [];

    Object.values(integratedData.items).forEach(item => {
      const receivers = []; // Branches needing stock
      const senders = [];   // Branches or GDG that can send stock

      Object.entries(item.outlets).forEach(([outlet, out]) => {
        // Gudang (GDG) can always supply if it has stock
        if (outlet === 'GDG' && out.stock > 0) {
          senders.push({
            outlet: 'GDG',
            stock: out.stock,
            available: out.stock,
            isGudang: true,
            ads: out.ads || 0,
            doc: Infinity
          });
          return;
        }

        // Check if outlet is a receiver (Critical / Low / Stockout)
        if (out.ads > 0) {
          const targetStock = Math.max(Math.ceil(out.ads * targetDays), 3);
          if (out.stock < targetStock) {
            const deficit = targetStock - out.stock;
            receivers.push({
              outlet,
              stock: out.stock,
              ads: out.ads,
              doc: out.doc,
              status: out.status,
              deficit,
              urgency: (out.stock === 0 || out.doc < 2) ? 'HIGH' : 'MEDIUM'
            });
          }
        }

        // Check if outlet is a sender (Overstocked, Dead stock, or high surplus)
        if (outlet !== 'GDG') {
          if (out.stock > 0 && out.ads === 0 && out.stock >= 5) {
            // Dead stock in branch: can transfer almost all of it
            senders.push({
              outlet,
              stock: out.stock,
              available: Math.floor(out.stock * 0.8),
              isGudang: false,
              ads: 0,
              doc: Infinity,
              isDeadStock: true
            });
          } else if (out.ads > 0 && (out.doc >= minOverstockDays || out.stock > Math.ceil(out.ads * 14))) {
            // Overstocked branch: keep safe 7 days, release excess
            const keepStock = Math.ceil(out.ads * targetDays);
            const excess = out.stock - keepStock;
            if (excess >= 3) {
              senders.push({
                outlet,
                stock: out.stock,
                available: excess,
                isGudang: false,
                ads: out.ads,
                doc: out.doc,
                isDeadStock: false
              });
            }
          }
        }
      });

      // Sort receivers: highest urgency first (stockout first, then lowest doc)
      receivers.sort((a, b) => {
        if (a.urgency !== b.urgency) return a.urgency === 'HIGH' ? -1 : 1;
        return a.doc - b.doc;
      });

      // Sort senders: GDG first, then dead stock, then largest excess
      senders.sort((a, b) => {
        if (a.isGudang) return -1;
        if (b.isGudang) return 1;
        return b.available - a.available;
      });

      // Match receivers with senders
      receivers.forEach(receiver => {
        let remainingNeed = receiver.deficit;

        for (const sender of senders) {
          if (remainingNeed <= 0) break;
          if (sender.available <= 0) continue;
          if (sender.outlet === receiver.outlet) continue;

          const transferQty = Math.min(remainingNeed, sender.available);
          if (transferQty <= 0) continue;

          sender.available -= transferQty;
          remainingNeed -= transferQty;

          let reason = '';
          if (sender.isGudang) {
            reason = `Distribusi rutin dari Gudang (Sisa di GDG: ${sender.stock - transferQty} PCS)`;
          } else if (sender.isDeadStock) {
            reason = `Mengalihkan dead stock dari ${sender.outlet} (0 penjualan, ada ${sender.stock} PCS)`;
          } else {
            reason = `Penyeimbangan overstock: ${sender.outlet} (DoC ${sender.doc} hari) ke ${receiver.outlet} (DoC ${receiver.doc} hari)`;
          }

          recommendations.push({
            itemCode: item.code,
            itemName: item.name,
            merk: item.merk,
            itemGroup: item.itemGroup,
            fromOutlet: sender.outlet,
            toOutlet: receiver.outlet,
            qty: transferQty,
            urgency: receiver.urgency,
            receiverStock: receiver.stock,
            receiverADS: receiver.ads,
            receiverDoc: receiver.doc,
            senderStock: sender.stock,
            senderADS: sender.ads,
            reason
          });
        }
      });
    });

    return recommendations;
  }

  /**
   * Generates Purchase Order (PO) Recommendations for network replenishment.
   * @param {Object} integratedData 
   * @param {Object} [options]
   * @returns {Array<Object>} List of PO suggestions
   */
  static generatePOSuggestions(integratedData, options = {}) {
    const leadTimeDays = options.leadTimeDays || 3;    // Delivery time from distributor
    const safetyDays = options.safetyDays || 4;        // Buffer stock days
    const targetCoverageDays = options.targetDays || 14;// Target total stock in network

    const suggestions = [];

    Object.values(integratedData.items).forEach(item => {
      const globalADS = item.totalADS || 0;
      if (globalADS <= 0) return; // Don't reorder non-selling items

      const globalStock = item.totalStock || 0;
      const reorderPoint = Math.ceil(globalADS * (leadTimeDays + safetyDays));
      const targetStock = Math.ceil(globalADS * targetCoverageDays);

      if (globalStock <= reorderPoint) {
        let suggestedQty = Math.max(0, targetStock - globalStock);
        // Round to nearest 5 pcs for retail packaging practicality
        if (suggestedQty > 5) {
          suggestedQty = Math.ceil(suggestedQty / 5) * 5;
        }

        const urgency = globalStock <= Math.ceil(globalADS * leadTimeDays) ? 'HIGH' : 'MEDIUM';

        suggestions.push({
          itemCode: item.code,
          itemName: item.name,
          merk: item.merk,
          itemGroup: item.itemGroup,
          globalStock,
          globalADS,
          globalDoC: item.globalDoC,
          reorderPoint,
          targetStock,
          suggestedQty,
          urgency,
          daysLeft: item.globalDoC
        });
      }
    });

    // Sort by most urgent (lowest days left)
    suggestions.sort((a, b) => a.daysLeft - b.daysLeft);
    return suggestions;
  }

  /**
   * Classifies all products into FSN (Fast, Slow, Non-Moving).
   * @param {Object} integratedData 
   * @returns {Object} { fast: [], medium: [], slow: [], nonMoving: [] }
   */
  static classifyFSN(integratedData) {
    const result = {
      fast: [],
      medium: [],
      slow: [],
      nonMoving: []
    };

    Object.values(integratedData.items).forEach(item => {
      const ads = item.totalADS || 0;
      const summary = {
        code: item.code,
        name: item.name,
        merk: item.merk,
        stock: item.totalStock,
        sold: item.totalSold,
        ads,
        doc: item.globalDoC
      };

      if (ads >= 5) {
        result.fast.push(summary);
      } else if (ads >= 1) {
        result.medium.push(summary);
      } else if (ads > 0) {
        result.slow.push(summary);
      } else {
        result.nonMoving.push(summary);
      }
    });

    return result;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = InventoryRebalancer;
} else {
  window.InventoryRebalancer = InventoryRebalancer;
}
