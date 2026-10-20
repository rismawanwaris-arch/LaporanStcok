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
    const targetDays = options.targetDays || 4;      // Target coverage days for receiver (3-5 hari cukup untuk konter)
    const minOverstockDays = options.minOverstockDays || 10; // Min days to consider sender overstocked (> 10 hari sudah overstock)

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
            isDeadStock: false,
            isIdleSurplus: false,
            ads: out.ads || 0,
            doc: Infinity
          });
          return;
        }

        // Check if outlet is a receiver (Stockout, Must-Have Empty, Critical, or Low Stock)
        if (out.ads > 0 && outlet !== 'GDG') {
          const minFloor = item.isMustHave ? 3 : 2;
          const targetStock = Math.max(Math.ceil(out.ads * targetDays), minFloor);
          if (out.stock < targetStock) {
            const deficit = targetStock - out.stock;
            const isUrgent = out.stock === 0 || out.doc < 2 || (item.isMustHave && out.stock <= 1);
            receivers.push({
              outlet,
              stock: out.stock,
              ads: out.ads,
              doc: out.doc,
              status: out.status,
              deficit,
              isHistoricalDemand: !!out.isHistoricalDemand,
              isMustHaveStockout: !!out.isMustHaveStockout,
              urgency: isUrgent ? 'HIGH' : 'MEDIUM'
            });
          }
        }

        // Check if outlet is a sender (Verified Dead Stock, Overstocked, or High Idle Surplus)
        if (outlet !== 'GDG') {
          // 1) Status DEAD_STOCK: Terbukti tidak laku >= deadStockDaysSetting dan bukan barang baru beli
          if (out.stock > 0 && out.status === 'DEAD_STOCK' && out.stock >= 3) {
            const minKeep = item.isMustHave ? 2 : Math.max(1, Math.floor(out.stock * 0.2));
            const available = Math.max(0, out.stock - minKeep);
            if (available >= 1) {
              const daysUnsold = out.neverSold
                ? `Belum pernah terjual di cabang ini`
                : `Tidak terjual ${out.agingDays} hari`;
              senders.push({
                outlet,
                stock: out.stock,
                available,
                isGudang: false,
                ads: 0,
                doc: Infinity,
                isDeadStock: true,
                isIdleSurplus: false,
                deadStockReason: daysUnsold
              });
            }
          }
          // 2) Overstocked active branch: keep safe buffer, release excess
          else if (out.ads > 0 && (out.doc >= minOverstockDays || out.stock > Math.ceil(out.ads * 12))) {
            const minKeep = item.isMustHave ? 3 : 2;
            const keepStock = Math.max(Math.ceil(out.ads * targetDays), minKeep);
            const excess = out.stock - keepStock;
            if (excess >= 2) {
              senders.push({
                outlet,
                stock: out.stock,
                available: excess,
                isGudang: false,
                ads: out.ads,
                doc: out.doc,
                isDeadStock: false,
                isIdleSurplus: false
              });
            }
          }
          // 3) High Idle Surplus: belum melewati batas hari Dead Stock, tapi menumpuk >= 6 PCS tanpa penjualan
          //    Hanya boleh dipakai untuk menolong cabang yang sedang HIGH urgency (Stok 0 / Kritis),
          //    dan wajib menyisakan minimal 3-4 PCS di cabang pengirim agar tidak kehabisan pajangan!
          else if (out.status === 'IDLE' && !out.isNewStock && out.stock >= 6) {
            const keepDisplay = Math.max(item.isMustHave ? 4 : 3, Math.ceil(out.stock * 0.5));
            const surplus = out.stock - keepDisplay;
            if (surplus >= 2) {
              senders.push({
                outlet,
                stock: out.stock,
                available: surplus,
                keepDisplay,
                isGudang: false,
                ads: 0,
                doc: Infinity,
                isDeadStock: false,
                isIdleSurplus: true
              });
            }
          }
        }
      });

      // Sort receivers: Must-Have stockouts & 0-stock first, then highest ADS, then lowest DoC
      receivers.sort((a, b) => {
        if (a.urgency !== b.urgency) return a.urgency === 'HIGH' ? -1 : 1;
        if ((a.stock === 0) !== (b.stock === 0)) return a.stock === 0 ? -1 : 1;
        if (b.ads !== a.ads) return b.ads - a.ads;
        return a.doc - b.doc;
      });

      // Sort senders: GDG first, then verified dead stock, then active overstock, then idle surplus last
      senders.sort((a, b) => {
        if (a.isGudang !== b.isGudang) return a.isGudang ? -1 : 1;
        if (a.isDeadStock !== b.isDeadStock) return a.isDeadStock ? -1 : 1;
        if (a.isIdleSurplus !== b.isIdleSurplus) return a.isIdleSurplus ? 1 : -1;
        return b.available - a.available;
      });

      // Match receivers with senders
      receivers.forEach(receiver => {
        let remainingNeed = receiver.deficit;

        for (const sender of senders) {
          if (remainingNeed <= 0) break;
          if (sender.available <= 0) continue;
          if (sender.outlet === receiver.outlet) continue;
          // Idle surplus senders only rescue HIGH urgency receivers (0 stock / critical)
          if (sender.isIdleSurplus && receiver.urgency !== 'HIGH') continue;

          const transferQty = Math.min(remainingNeed, sender.available);
          if (transferQty <= 0) continue;

          sender.available -= transferQty;
          remainingNeed -= transferQty;

          const receiverNote = item.isMustHave && receiver.stock === 0
            ? ` [SKU Wajib Kosong di ${receiver.outlet}]`
            : (receiver.isHistoricalDemand && receiver.stock === 0 ? ` [Stok 0 di ${receiver.outlet}, riwayat laku ${receiver.ads}/hr]` : '');

          let reason = '';
          if (sender.isGudang) {
            reason = `Distribusi dari Gudang ke ${receiver.outlet} (Sisa GDG: ${sender.stock - transferQty} PCS)${receiverNote}`;
          } else if (sender.isDeadStock) {
            reason = `Mengalihkan dead stock dari ${sender.outlet} (${sender.deadStockReason}, stok ${sender.stock} PCS)${receiverNote}`;
          } else if (sender.isIdleSurplus) {
            reason = `Pemerataan stok pasif dari ${sender.outlet} (Stok ${sender.stock} PCS belum bergerak, disisakan ${sender.stock - transferQty} PCS di cabang)${receiverNote}`;
          } else {
            reason = `Penyeimbangan overstock: ${sender.outlet} (DoC ${sender.doc} hr) ke ${receiver.outlet} (DoC ${receiver.doc} hr)${receiverNote}`;
          }

          recommendations.push({
            itemCode: item.code,
            itemName: item.name,
            merk: item.merk,
            itemGroup: item.itemGroup,
            isMustHave: !!item.isMustHave,
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

    // Sort global recommendations: Must-Have HIGH urgency first, then HIGH urgency, then highest qty
    recommendations.sort((a, b) => {
      if (a.urgency !== b.urgency) return a.urgency === 'HIGH' ? -1 : 1;
      if (a.isMustHave !== b.isMustHave) return a.isMustHave ? -1 : 1;
      if ((a.receiverStock === 0) !== (b.receiverStock === 0)) return a.receiverStock === 0 ? -1 : 1;
      return b. receiverADS - a.receiverADS;
    });

    return recommendations;
  }

  /**
   * Generates Purchase Order (PO) Recommendations for network replenishment.
   * Considers both global network coverage AND unfulfilled branch stockout deficits
   * (when stock is fragmented as 1-2 pcs across branches and GDG is empty).
   *
   * @param {Object} integratedData 
   * @param {Object} [options]
   * @returns {Array<Object>} List of PO suggestions
   */
  static generatePOSuggestions(integratedData, options = {}) {
    const leadTimeDays = options.leadTimeDays || 2;    // Delivery time from distributor (biasanya 1-2 hari)
    const safetyDays = options.safetyDays || 2;        // Buffer stock days (2 hari buffer)
    const targetCoverageDays = options.targetDays || 7;// Target total stock in network (7 hari perputaran cashflow)

    const suggestions = [];

    Object.values(integratedData.items).forEach(item => {
      const globalADS = item.totalADS || 0;
      if (globalADS <= 0) return; // Don't reorder non-selling items

      const globalStock = item.totalStock || 0;
      const gdgStock = item.gdgStock || 0;
      const reorderPoint = Math.ceil(globalADS * (leadTimeDays + safetyDays));
      const targetStock = Math.ceil(globalADS * targetCoverageDays);

      // Calculate branch-level critical deficit vs transferable supply
      // (Catches the case where globalStock > reorderPoint because 25 branches hold 1 pc each,
      //  while 10 branches are 0-stock and GDG is empty!)
      let criticalBranchDeficit = 0;
      let transferableSupply = gdgStock;
      let emptyBranchesCount = 0;

      Object.entries(item.outlets).forEach(([outlet, out]) => {
        if (outlet === 'GDG') return;
        if (out.status === 'OUT_OF_STOCK' || out.status === 'CRITICAL') {
          const minTarget = Math.max(Math.ceil(out.ads * 4), item.isMustHave ? 3 : 2);
          criticalBranchDeficit += Math.max(0, minTarget - out.stock);
          if (out.stock === 0) emptyBranchesCount += 1;
        } else if (out.status === 'DEAD_STOCK' && out.stock >= 3) {
          transferableSupply += Math.floor(out.stock * 0.7);
        } else if (out.status === 'OVERSTOCK' && out.ads > 0) {
          transferableSupply += Math.max(0, out.stock - Math.ceil(out.ads * 4));
        }
      });

      const unfulfilledDeficit = Math.max(0, criticalBranchDeficit - transferableSupply);
      const needsNetworkReorder = globalStock <= reorderPoint;
      const needsBranchRescueOrder = unfulfilledDeficit >= 3 && emptyBranchesCount >= 2 && (item.isMustHave || globalADS >= 1);

      if (needsNetworkReorder || needsBranchRescueOrder) {
        let suggestedQty = Math.max(targetStock - globalStock, unfulfilledDeficit);
        if (suggestedQty <= 0) return;

        // Round to nearest 5 pcs for retail packaging practicality
        if (suggestedQty > 5) {
          suggestedQty = Math.ceil(suggestedQty / 5) * 5;
        }

        const isHighUrgency = globalStock <= Math.ceil(globalADS * leadTimeDays)
          || (item.isMustHave && emptyBranchesCount >= 3 && gdgStock === 0);
        const urgency = isHighUrgency ? 'HIGH' : 'MEDIUM';

        const poReason = needsNetworkReorder
          ? `Stok jaringan (${globalStock} PCS) di bawah titik pesan (${reorderPoint} PCS)`
          : `Stok GDG habis & ${emptyBranchesCount} cabang kosong (defisit ${unfulfilledDeficit} PCS tidak tertutupi transfer)`;

        suggestions.push({
          itemCode: item.code,
          itemName: item.name,
          merk: item.merk,
          itemGroup: item.itemGroup,
          isMustHave: !!item.isMustHave,
          abcClass: item.abcClass || '-',
          globalStock,
          gdgStock,
          emptyBranchesCount,
          globalADS,
          globalDoC: item.globalDoC,
          reorderPoint,
          targetStock,
          suggestedQty,
          unitCost: item.unitCost || 0,
          estimatedCost: Math.round(suggestedQty * (item.unitCost || 0)),
          urgency,
          poReason,
          daysLeft: item.globalDoC
        });
      }
    });

    // Sort by HIGH urgency first, Must-Have first, then lowest days left
    suggestions.sort((a, b) => {
      if (a.urgency !== b.urgency) return a.urgency === 'HIGH' ? -1 : 1;
      if (a.isMustHave !== b.isMustHave) return a.isMustHave ? -1 : 1;
      return a.daysLeft - b.daysLeft;
    });
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
