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
    const minOverstockDays = options.minOverstockDays || 10; // Min days to consider sender overstocked (> 10 hari sudah overstock)

    // Pengaturan Global & Standar Kategori (dapat diatur dari Sidebar Pengaturan Transfer)
    const settings = integratedData.settings || {};
    const globalTargetDays = Math.max(1, parseInt(options.targetDays ?? settings.targetDays ?? 4, 10) || 4);
    const globalMinTransferQty = Math.max(1, parseInt(options.minTransferQty ?? settings.minTransferQty ?? 3, 10) || 3);
    const globalMinSenderKeepPcs = Math.max(1, parseInt(options.minSenderKeepPcs ?? settings.minSenderKeepPcs ?? 5, 10) || 5);
    const maxTransferPct = Math.min(90, Math.max(10, parseInt(options.maxTransferPct ?? settings.maxTransferPct ?? 50, 10) || 50));
    const minKeepRatio = (100 - maxTransferPct) / 100; // Misal maxTransferPct = 50% -> wajib sisakan minimal 50% stok di cabang asal
    const categoryRulesMap = settings.categoryTransferRules || {};

    const recommendations = [];

    Object.values(integratedData.items).forEach(item => {
      const catName = item.itemGroup || 'LAINNYA';
      const catRule = categoryRulesMap[catName] || {};
      const urgencyMode = catRule.urgencyMode || 'STANDAR';

      // Jika kategori dinonaktifkan dari saran transfer oleh Admin, lewati
      if (urgencyMode === 'NONAKTIF') return;

      const itemTargetDays = Math.max(1, parseInt(catRule.targetDays ?? globalTargetDays, 10) || globalTargetDays);
      const itemMinTransferQty = Math.max(1, parseInt(catRule.minTransferQty ?? globalMinTransferQty, 10) || globalMinTransferQty);
      const itemMinSenderKeepPcs = Math.max(1, parseInt(catRule.minSenderKeepPcs ?? globalMinSenderKeepPcs, 10) || globalMinSenderKeepPcs);
      const senderKeepDays = Math.max(options.senderKeepDays || 7, itemTargetDays + 3);
      const categoryPriorityRank = urgencyMode === 'PRIORITAS_UTAMA' ? 3 : (urgencyMode === 'STANDAR' ? 2 : 1);

      const receivers = []; // Branches needing stock
      const senders = [];   // Branches or GDG that can send stock

      Object.entries(item.outlets).forEach(([outlet, out]) => {
        // Gudang (GDG) can always supply 100% of its stock if it has stock
        if (outlet === 'GDG' && out.stock > 0) {
          senders.push({
            outlet: 'GDG',
            stock: out.stock,
            remainingStock: out.stock,
            keepStock: 0,
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
          // Jika mode kategori adalah HANYA_KOSONG, hanya cabang yang stoknya 0 PCS yang menjadi penerima
          if (urgencyMode === 'HANYA_KOSONG' && out.stock > 0) {
            // Skip non-empty branches for HANYA_KOSONG categories
          } else {
            const minFloor = Math.max(item.isMustHave ? 3 : 2, itemMinTransferQty);
            const targetStock = Math.max(Math.ceil(out.ads * itemTargetDays), minFloor);
            if (out.stock < targetStock) {
              // Pastikan defisit minimal sebesar standar minimal kirim (`itemMinTransferQty`) agar tidak tanggung
              const rawDeficit = targetStock - out.stock;
              const deficit = Math.max(rawDeficit, itemMinTransferQty);
              const isUrgent = out.stock === 0
                || out.doc < (urgencyMode === 'PRIORITAS_UTAMA' ? 3 : 2)
                || (item.isMustHave && out.stock <= 1);
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
        }

        // Check if outlet is a sender (Verified Dead Stock, Overstocked, or High Idle Surplus)
        // ATURAN EMAS CABANG ASAL (NON-GDG):
        // Cabang ritel TIDAK BOLEH dikuras habis! Setiap cabang pengirim wajib menyisakan:
        // 1) Minimal `baseMinKeepPcs` (sesuai standar kategori / global), DAN
        // 2) Minimal `minKeepByPct` (persentase stok wajib tinggal, default 50% dari stok awal), DAN
        // 3) Minimal `minKeepByAds` (kebutuhan jualan cabang pengirim sendiri selama 7 hari).
        if (outlet !== 'GDG' && out.stock > 0) {
          const baseMinKeepPcs = item.isMustHave ? Math.max(itemMinSenderKeepPcs, 5) : itemMinSenderKeepPcs;
          const minKeepByPct = Math.ceil(out.stock * minKeepRatio);
          const minKeepByAds = out.ads > 0 ? Math.ceil(out.ads * senderKeepDays) : 0;

          // 1) Status DEAD_STOCK: Terbukti tidak laku >= deadStockDaysSetting dan bukan barang baru beli
          if (out.status === 'DEAD_STOCK') {
            const keepStock = Math.max(Math.min(baseMinKeepPcs, 3), minKeepByPct);
            const available = Math.max(0, out.stock - keepStock);
            if (available >= itemMinTransferQty) {
              const daysUnsold = out.neverSold
                ? `Belum pernah terjual di cabang ini`
                : `Tidak terjual ${out.agingDays} hari`;
              senders.push({
                outlet,
                stock: out.stock,
                remainingStock: out.stock,
                keepStock,
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
          // 2) Overstocked active branch: wajib sisakan 7 hari penjualan, minimal PCS pajangan kategori, dan minimal % stok tinggal
          else if (out.ads > 0 && (out.doc >= minOverstockDays || out.stock > Math.ceil(out.ads * 12))) {
            const keepStock = Math.max(baseMinKeepPcs, minKeepByPct, minKeepByAds);
            const excess = Math.max(0, out.stock - keepStock);
            if (excess >= itemMinTransferQty) {
              senders.push({
                outlet,
                stock: out.stock,
                remainingStock: out.stock,
                keepStock,
                available: excess,
                isGudang: false,
                ads: out.ads,
                doc: out.doc,
                isDeadStock: false,
                isIdleSurplus: false
              });
            }
          }
          // 3) High Idle Surplus: belum melewati batas hari Dead Stock, tapi menumpuk tinggi tanpa penjualan
          else if (out.status === 'IDLE' && !out.isNewStock) {
            const keepStock = Math.max(baseMinKeepPcs, minKeepByPct);
            const surplus = Math.max(0, out.stock - keepStock);
            if (surplus >= itemMinTransferQty) {
              senders.push({
                outlet,
                stock: out.stock,
                remainingStock: out.stock,
                keepStock,
                available: surplus,
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
          // Jangan kirim jika ketersediaan cabang pengirim di bawah standar minimal pengiriman (`itemMinTransferQty`)
          if (sender.available < itemMinTransferQty) continue;
          if (sender.outlet === receiver.outlet) continue;
          // Idle surplus senders only rescue HIGH urgency receivers (0 stock / critical)
          if (sender.isIdleSurplus && receiver.urgency !== 'HIGH') continue;

          // Jika sisa kebutuhan < itemMinTransferQty tapi pengirim masih punya >= itemMinTransferQty,
          // genapkan ke itemMinTransferQty agar jumlah pengiriman selalu memenuhi standar minimal (misal min 3 PCS)
          const desiredQty = Math.max(remainingNeed, itemMinTransferQty);
          const peerCap = sender.isGudang
            ? desiredQty
            : Math.min(desiredQty, Math.max(itemMinTransferQty, Math.ceil(receiver.ads * 2.5), 12));
          const transferQty = Math.min(peerCap, sender.available);

          // Wajib memenuhi batas minimal pengiriman per rute (`itemMinTransferQty`)
          if (transferQty < itemMinTransferQty) continue;

          sender.available -= transferQty;
          sender.remainingStock -= transferQty;
          remainingNeed -= transferQty;

          const receiverNote = item.isMustHave && receiver.stock === 0
            ? ` [SKU Wajib Kosong di ${receiver.outlet}]`
            : (receiver.isHistoricalDemand && receiver.stock === 0 ? ` [Stok 0 di ${receiver.outlet}, riwayat laku ${receiver.ads}/hr]` : '');

          let reason = '';
          if (sender.isGudang) {
            reason = `Distribusi Gudang ke ${receiver.outlet} (Stok GDG: ${sender.stock} ➔ Sisa ${sender.remainingStock} PCS)${receiverNote}`;
          } else if (sender.isDeadStock) {
            reason = `Relokasi sebagian dead stock ${sender.outlet} (${sender.deadStockReason} · Stok ${sender.stock} ➔ Disisakan ${sender.remainingStock} PCS)${receiverNote}`;
          } else if (sender.isIdleSurplus) {
            reason = `Pemerataan stok pasif dari ${sender.outlet} (Stok awal ${sender.stock} ➔ Disisakan ${sender.remainingStock} PCS di cabang asal)${receiverNote}`;
          } else {
            reason = `Penyeimbangan overstock ${sender.outlet} (DoC ${sender.doc} hr · Stok ${sender.stock} ➔ Disisakan ${sender.remainingStock} PCS)${receiverNote}`;
          }

          recommendations.push({
            itemCode: item.code,
            itemName: item.name,
            merk: item.merk,
            itemGroup: catName,
            categoryUrgencyMode: urgencyMode,
            categoryPriorityRank,
            minTransferRule: itemMinTransferQty,
            isMustHave: !!item.isMustHave,
            fromOutlet: sender.outlet,
            toOutlet: receiver.outlet,
            qty: transferQty,
            urgency: receiver.urgency,
            receiverStock: receiver.stock,
            receiverADS: receiver.ads,
            receiverDoc: receiver.doc,
            senderStock: sender.stock,
            senderRemainingStock: sender.remainingStock,
            senderKeepFloor: sender.keepStock,
            senderADS: sender.ads,
            reason
          });
        }
      });
    });

    // Sort global recommendations: Urgency HIGH -> Category Priority Rank -> Must-Have -> 0-Stock -> ADS
    recommendations.sort((a, b) => {
      if (a.urgency !== b.urgency) return a.urgency === 'HIGH' ? -1 : 1;
      if (b.categoryPriorityRank !== a.categoryPriorityRank) return b.categoryPriorityRank - a.categoryPriorityRank;
      if (a.isMustHave !== b.isMustHave) return a.isMustHave ? -1 : 1;
      if ((a.receiverStock === 0) !== (b.receiverStock === 0)) return a.receiverStock === 0 ? -1 : 1;
      return b.receiverADS - a.receiverADS;
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
      const settings = integratedData.settings || {};
      const minSenderKeepPcs = Math.max(1, parseInt(settings.minSenderKeepPcs ?? 5, 10) || 5);
      const maxTransferPct = Math.min(90, Math.max(10, parseInt(settings.maxTransferPct ?? 50, 10) || 50));
      const minKeepRatio = (100 - maxTransferPct) / 100;

      Object.entries(item.outlets).forEach(([outlet, out]) => {
        if (outlet === 'GDG') return;
        const baseMinKeep = item.isMustHave ? Math.max(minSenderKeepPcs, 5) : minSenderKeepPcs;
        const minKeepByPct = Math.ceil((out.stock || 0) * minKeepRatio);

        if (out.status === 'OUT_OF_STOCK' || out.status === 'CRITICAL') {
          const minTarget = Math.max(Math.ceil(out.ads * 4), item.isMustHave ? 3 : 2);
          criticalBranchDeficit += Math.max(0, minTarget - out.stock);
          if (out.stock === 0) emptyBranchesCount += 1;
        } else if (out.status === 'DEAD_STOCK' && out.stock >= 3) {
          const keep = Math.max(Math.min(baseMinKeep, 3), minKeepByPct);
          transferableSupply += Math.max(0, out.stock - keep);
        } else if (out.status === 'OVERSTOCK' && out.ads > 0) {
          const keep = Math.max(baseMinKeep, minKeepByPct, Math.ceil(out.ads * 7));
          transferableSupply += Math.max(0, out.stock - keep);
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
