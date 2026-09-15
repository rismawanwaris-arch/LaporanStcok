/**
 * Main Application Controller for Voucher Stock Analytics.
 */

// Global HTML Escaper utility to prevent XSS and reference errors
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
window.escapeHtml = escapeHtml;

document.addEventListener('DOMContentLoaded', () => {
  // Global State
  let appState = {
    parsedData: null,
    activeMerk: '',
    searchQuery: '',
    itemChart: null,
    outletChart: null,
    sorterInstance: null,
    currentDate: '',
    datesList: [],
    isBackendAvailable: false
  };

  // DOM Elements
  const statusMessage = document.getElementById('status-message');
  const statusText = document.getElementById('status-text');
  
  const statMerks = document.getElementById('stat-merks');
  const statItems = document.getElementById('stat-items');
  const statOutlets = document.getElementById('stat-outlets');
  const statStock = document.getElementById('stat-stock');
  
  const dateSelector = document.getElementById('date-selector');
  const btnDeleteDate = document.getElementById('btn-delete-date');
  const merkSelector = document.getElementById('merk-selector');
  const searchInput = document.getElementById('search-input');
  
  const tableHeaders = document.getElementById('table-headers');
  const tableBody = document.getElementById('stock-table-body');
  
  const btnResetOrder = document.getElementById('btn-reset-order');
  const btnExportCsv = document.getElementById('btn-export-csv');
  const btnExportXlsx = document.getElementById('btn-export-xlsx');
  const btnFullscreen = document.getElementById('btn-fullscreen');
  const btnDbManage = document.getElementById('btn-db-manage');

  // Initialize UI components
  init();

  function init() {
    setupSidebar();
    setupTheme();
    setupFilters();
    setupActions();
    setupDatabaseModal();
    setupTabs();
    setupRebalanceControls();
    setupCoverageControls();
    setupPOControls();
    setupImportCenter();
    
    // Check backend API and database first, fallback to static CSV
    checkBackendAndLoad();
  }

  // 1. Check Backend API and Load Dates History
  async function checkBackendAndLoad() {
    try {
      showStatus("Menghubungkan ke database riwayat...", "info");
      const res = await fetch('/api/dates');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (data && data.success && Array.isArray(data.dates) && data.dates.length > 0) {
        appState.isBackendAvailable = true;
        appState.datesList = data.dates;
        populateDateSelector(data.dates);
        // Automatically load the latest date
        const latestDate = data.dates[0].report_date;
        await loadStockByDate(latestDate);
        return;
      } else if (data && data.success) {
        // Connected to backend, but database is empty
        appState.isBackendAvailable = true;
        dateSelector.innerHTML = '<option value="">(Database masih kosong)</option>';
        fetchDefaultCSV();
        return;
      }
      throw new Error("Respon server tidak valid");
    } catch (err) {
      console.log('Backend server offline. Berjalan dalam mode lokal:', err.message);
      appState.isBackendAvailable = false;
      if (dateSelector) {
        dateSelector.innerHTML = '<option value="">Mode Lokal (Offline)</option>';
        dateSelector.disabled = true;
      }
      if (btnDeleteDate) btnDeleteDate.style.display = 'none';
      fetchDefaultCSV();
    }
  }

  function populateDateSelector(dates) {
    if (!dateSelector) return;
    dateSelector.innerHTML = '';
    dateSelector.disabled = false;
    dates.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.report_date;
      const formattedDate = formatDateDisplay(d.report_date);
      const totalFmt = (d.total_stock || 0).toLocaleString('id-ID');
      opt.textContent = `${formattedDate} (${totalFmt} PCS - ${d.filename || 'Laporan'})`;
      dateSelector.appendChild(opt);
    });
  }

  function formatDateDisplay(ymd) {
    if (!ymd || typeof ymd !== 'string') return ymd;
    const parts = ymd.split('-');
    if (parts.length === 3) {
      return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
    return ymd;
  }

  async function loadStockByDate(reportDate) {
    try {
      showStatus(`Memuat data tanggal ${formatDateDisplay(reportDate)}...`, 'info');
      const res = await fetch(`/api/stock?date=${encodeURIComponent(reportDate)}`);
      if (!res.ok) throw new Error('Gagal mengambil data dari server');
      const json = await res.json();
      if (!json.success || !json.report) throw new Error(json.message || 'Data tidak ditemukan');

      appState.currentDate = reportDate;
      appState.parsedData = json.report.data;
      if (dateSelector) dateSelector.value = reportDate;
      if (btnDeleteDate) btnDeleteDate.style.display = 'inline-flex';

      showStatus(`Menampilkan data tanggal ${formatDateDisplay(reportDate)} (${(json.report.total_stock || 0).toLocaleString('id-ID')} PCS) dari Database.`, 'info');

      renderOverview();
      renderMerkSelector();

      // Select 'ALL' by default
      merkSelector.value = 'ALL';
      appState.activeMerk = 'ALL';
      onMerkChanged();

      lucide.createIcons();
    } catch (err) {
      console.error(err);
      showStatus(`Error memuat data tanggal ${reportDate}: ${err.message}`, 'warning');
    }
  }

  // 2. Fetch Default CSV from relative path (Fallback)
  function fetchDefaultCSV() {
    showStatus("Memuat data default...", "info");
    fetch('1308 vcr_new.csv')
      .then(response => {
        if (!response.ok) return fetch('1308 vcr.csv');
        return response;
      })
      .then(response => {
        if (!response.ok) {
          throw new Error("File default tidak ditemukan. Silakan unggah secara manual.");
        }
        const loadedFile = response.url.includes('1308_new') || response.url.includes('1308%20vcr_new') ? '1308 vcr_new.csv' : '1308 vcr.csv';
        return response.text().then(text => ({ text, loadedFile }));
      })
      .then(({ text, loadedFile }) => {
        processCSVContent(text, loadedFile);
      })
      .catch(err => {
        console.warn(err.message);
        showStatus(err.message, "warning");
      });
  }

  function showStatus(msg, type) {
    statusMessage.style.display = 'flex';
    statusMessage.className = `status-msg ${type}`;
    statusText.textContent = msg;
  }

  // 3. Process CSV text content
  function processCSVContent(csvText, sourceName) {
    try {
      const parsed = StockDataParser.parse(csvText);
      
      // Verify parsed output is valid
      const merkKeys = Object.keys(parsed.merks);
      if (merkKeys.length === 0) {
        throw new Error("Format CSV tidak didukung atau data kosong.");
      }

      appState.parsedData = parsed;
      showStatus(`Berhasil memuat ${merkKeys.length} merk dari "${sourceName}"!`, 'info');
      
      // Render components
      renderOverview();
      renderMerkSelector();
      
      // Select 'ALL' by default
      merkSelector.value = 'ALL';
      appState.activeMerk = 'ALL';
      onMerkChanged();

      // Re-initialize icons
      lucide.createIcons();

    } catch (err) {
      console.error(err);
      showStatus(`Error parsing CSV: ${err.message}`, 'warning');
    }
  }

  // 4. Update Overview KPI Cards
  function renderOverview() {
    const overview = StockAnalytics.getOverview(appState.parsedData);
    
    statMerks.textContent = overview.global.totalMerks;
    statItems.textContent = overview.global.totalItems;
    statOutlets.textContent = overview.global.totalOutlets;
    statStock.textContent = overview.global.totalStock.toLocaleString('id-ID');
  }

  // 5. Populate Merk Dropdown
  function renderMerkSelector() {
    // Clear previous options except placeholder
    merkSelector.innerHTML = '<option value="ALL">-- Tampilkan Semua Merk --</option>';
    
    Object.keys(appState.parsedData.merks).forEach(merk => {
      const option = document.createElement('option');
      option.value = merk;
      option.textContent = merk;
      merkSelector.appendChild(option);
    });
  }

  // 6. Setup filters (Selectors & Search)
  function setupFilters() {
    if (dateSelector) {
      dateSelector.addEventListener('change', (e) => {
        const selectedDate = e.target.value;
        if (selectedDate && appState.isBackendAvailable) {
          loadStockByDate(selectedDate);
        }
      });
    }

    merkSelector.addEventListener('change', (e) => {
      appState.activeMerk = e.target.value;
      onMerkChanged();
    });

    searchInput.addEventListener('input', (e) => {
      appState.searchQuery = e.target.value.toLowerCase().trim();
      filterTableRows();
    });
  }

  function onMerkChanged() {
    if (!appState.activeMerk) {
      clearUI();
      return;
    }
    renderTable();
    renderCharts();
  }

  function clearUI() {
    tableHeaders.innerHTML = '<th>Barang / Item</th><th>TOTAL (PCS)</th>';
    tableBody.innerHTML = `
      <tr>
        <td colspan="2" style="text-align: center; padding: 40px; color: var(--text-muted);">
          Silakan pilih merk atau upload file CSV untuk memuat data tabel.
        </td>
      </tr>
    `;
    if (appState.itemChart) appState.itemChart.destroy();
    if (appState.outletChart) appState.outletChart.destroy();
  }

  // 7. Render Stock Table with columns = Outlets, rows = Items
  function renderTable() {
    let merkData;
    if (appState.activeMerk === 'ALL') {
      merkData = {
        name: 'SEMUA MERK',
        items: {},
        outlets: appState.parsedData.allOutlets
      };
      Object.values(appState.parsedData.merks).forEach(merkObj => {
        Object.assign(merkData.items, merkObj.items);
      });
    } else {
      merkData = appState.parsedData.merks[appState.activeMerk];
    }
    if (!merkData) return;

    const items = Object.values(merkData.items);
    
    // Sort outlets according to custom drag order or CSV default order
    const outlets = OutletSorter.sortOutlets(merkData.outlets, appState.activeMerk);

    // Render Table Headers (Columns = Outlets)
    let headerHtml = `<th class="non-draggable">Barang / Item</th>`;
    
    outlets.forEach(outlet => {
      headerHtml += `
        <th data-outlet="${escapeHtml(outlet)}" style="cursor: grab; min-width: 42px; max-width: 55px; width: 48px; text-align: center;">
          <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;">
            <div class="drag-handle" style="opacity: 0.4; padding: 1px;">
              <i data-lucide="grip-horizontal" style="width: 10px; height: 10px;"></i>
            </div>
            <div style="font-size: 9px; font-weight: 700; text-align: center; line-height: 1.15; white-space: normal; word-break: break-word; max-width: 44px;">${escapeHtml(outlet)}</div>
          </div>
        </th>
      `;
    });
    headerHtml += `<th class="non-draggable" style="text-align: center;">TOTAL (PCS)</th>`;
    tableHeaders.innerHTML = headerHtml;

    // Render Rows (Rows = Items)
    let tbodyHtml = '';
    
    items.forEach(item => {
      let itemTotal = 0;
      let cellsHtml = '';

      outlets.forEach(outlet => {
        const stock = item.stocks[outlet] || 0;
        itemTotal += stock;

        // Apply heat map coloring class
        let heatClass = 'stock-zero';
        if (stock > 0 && stock <= 3) {
          heatClass = 'stock-low';
        } else if (stock > 3 && stock <= 15) {
          heatClass = 'stock-medium';
        } else if (stock > 15) {
          heatClass = 'stock-high';
        }

        cellsHtml += `
          <td class="stock-cell ${heatClass}">
            ${stock > 0 ? stock : '-'}
          </td>
        `;
      });

      tbodyHtml += `
        <tr data-item-code="${escapeHtml(item.code)}" data-item-name="${escapeHtml(item.name.toLowerCase())}">
          <td>
            <div style="font-weight: 600; color: var(--text-primary); white-space: normal; min-width: 220px;">${escapeHtml(item.name)}</div>
            <div style="font-size: 11px; color: var(--text-muted);">${escapeHtml(item.code)}</div>
          </td>
          ${cellsHtml}
          <td class="outlet-total" style="font-weight: 700; color: var(--accent-cyan); text-align: center;">${itemTotal}</td>
        </tr>
      `;
    });

    // Render the bottom TOTAL summary row
    let totalCellsHtml = '';
    let grandTotal = 0;
    
    outlets.forEach(outlet => {
      let outletTotal = 0;
      items.forEach(item => {
        outletTotal += item.stocks[outlet] || 0;
      });
      grandTotal += outletTotal;
      totalCellsHtml += `<td style="font-weight: 800; color: var(--accent-indigo); text-align: center;">${outletTotal}</td>`;
    });

    tbodyHtml += `
      <tr style="background: rgba(99, 102, 241, 0.05); border-top: 2px solid var(--panel-border);">
        <td>
          <div style="font-weight: 800; color: var(--text-primary); text-transform: uppercase;">TOTAL</div>
        </td>
        ${totalCellsHtml}
        <td style="font-weight: 800; color: var(--accent-cyan); text-align: center;">${grandTotal}</td>
      </tr>
    `;

    tableBody.innerHTML = tbodyHtml;
    lucide.createIcons();

    // Setup drag-and-drop on the header row <tr> element
    if (appState.sorterInstance) {
      appState.sorterInstance.destroy();
    }
    
    appState.sorterInstance = new OutletSorter(tableHeaders, appState.activeMerk, (newOrder) => {
      // Callback triggered when user finishes dragging columns
      console.log('Outlet order updated:', newOrder);
      // Rerender table so that body cells are correctly aligned with headers
      renderTable();
      renderCharts(); 
    });

    // If there is a current search query, filter immediately
    if (appState.searchQuery) {
      filterTableRows();
    }
  }

  // 8. Filter Table Rows based on Search
  function filterTableRows() {
    const rows = tableBody.querySelectorAll('tr[data-item-code]');
    const q = appState.searchQuery;
    
    rows.forEach(row => {
      const code = row.getAttribute('data-item-code').toLowerCase();
      const name = row.getAttribute('data-item-name').toLowerCase();
      const match = code.includes(q) || name.includes(q);
      row.style.display = match ? '' : 'none';
    });
  }

  // 9. Render Chart.js Visualizations
  function renderCharts() {
    let merkData;
    if (appState.activeMerk === 'ALL') {
      merkData = {
        name: 'SEMUA MERK',
        items: {},
        outlets: appState.parsedData.allOutlets
      };
      Object.values(appState.parsedData.merks).forEach(merkObj => {
        Object.assign(merkData.items, merkObj.items);
      });
    } else {
      merkData = appState.parsedData.merks[appState.activeMerk];
    }
    if (!merkData) return;

    // Destory existing charts
    if (appState.itemChart) appState.itemChart.destroy();
    if (appState.outletChart) appState.outletChart.destroy();

    // Gather statistics
    const itemsData = StockAnalytics.getItemStatistics(merkData);
    const sortedOutlets = OutletSorter.sortOutlets(merkData.outlets, appState.activeMerk);
    
    const outletsStats = sortedOutlets.map(outlet => {
      let total = 0;
      Object.values(merkData.items).forEach(item => {
        total += item.stocks[outlet] || 0;
      });
      return { name: outlet, total: total };
    }).filter(o => o.total > 0); // Only show outlets with stock

    // Read theme variables
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const gridColor = isLight ? 'rgba(15, 23, 42, 0.05)' : 'rgba(255, 255, 255, 0.04)';
    const tickColor = isLight ? '#475569' : '#9ca3af';
    const tooltipBg = isLight ? 'rgba(255, 255, 255, 0.98)' : 'rgba(17, 25, 40, 0.95)';
    const tooltipBorder = isLight ? 'rgba(15, 23, 42, 0.1)' : 'rgba(6, 182, 212, 0.2)';
    const tooltipTextPrimary = isLight ? '#0f172a' : '#f3f4f6';
    const tooltipTextSecondary = isLight ? '#475569' : '#9ca3af';

    // --- Chart 1: Item Stock Chart (Bar Chart) ---
    const ctxItem = document.getElementById('itemChart').getContext('2d');
    
    // Select top 15 items for readability
    const topItems = itemsData.allItems.slice(0, 15);

    appState.itemChart = new Chart(ctxItem, {
      type: 'bar',
      data: {
        labels: topItems.map(item => item.name.length > 20 ? item.name.substring(0, 20) + '...' : item.name),
        datasets: [{
          label: 'Total Stock (PCS)',
          data: topItems.map(item => item.totalStock),
          backgroundColor: 'rgba(6, 182, 212, 0.4)',
          borderColor: '#06b6d4',
          borderWidth: 1.5,
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: tooltipBg,
            borderColor: tooltipBorder,
            borderWidth: 1,
            titleColor: tooltipTextPrimary,
            bodyColor: tooltipTextSecondary
          }
        },
        scales: {
          x: {
            grid: { color: gridColor },
            ticks: { color: tickColor, font: { size: 10 } }
          },
          y: {
            grid: { color: gridColor },
            ticks: { color: tickColor }
          }
        }
      }
    });

    // --- Chart 2: Outlet Contribution (Doughnut Chart) ---
    const ctxOutlet = document.getElementById('outletChart').getContext('2d');
    
    // Select top 8 outlets, bundle rest into "Others"
    let chartOutlets = [...outletsStats];
    if (chartOutlets.length > 8) {
      const top8 = chartOutlets.slice(0, 8);
      const othersSum = chartOutlets.slice(8).reduce((sum, curr) => sum + curr.total, 0);
      chartOutlets = [...top8, { name: 'Lainnya', total: othersSum }];
    }

    const neonColors = [
      '#06b6d4', '#3b82f6', '#6366f1', '#a855f7', 
      '#ec4899', '#f43f5e', '#10b981', '#f59e0b', '#6b7280'
    ];

    appState.outletChart = new Chart(ctxOutlet, {
      type: 'doughnut',
      data: {
        labels: chartOutlets.map(o => o.name),
        datasets: [{
          data: chartOutlets.map(o => o.total),
          backgroundColor: neonColors.slice(0, chartOutlets.length).map(c => c + '33'), // 20% opacity
          borderColor: neonColors.slice(0, chartOutlets.length),
          borderWidth: 1.5,
          hoverOffset: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'right',
            labels: { color: tickColor, boxWidth: 12, font: { size: 10 } }
          },
          tooltip: {
            backgroundColor: tooltipBg,
            borderColor: tooltipBorder,
            borderWidth: 1,
            titleColor: tooltipTextPrimary,
            bodyColor: tooltipTextSecondary
          }
        }
      }
    });
  }

  // 10. Setup custom buttons actions (Reset, Export)
  function setupActions() {
    // Reset order
    btnResetOrder.addEventListener('click', () => {
      if (!appState.activeMerk) return;
      
      const label = appState.activeMerk === 'ALL' ? 'semua merk' : `merk "${appState.activeMerk}"`;
      const confirmReset = confirm(`Apakah Anda yakin ingin menyetel ulang urutan outlet untuk ${label}?`);
      if (confirmReset) {
        OutletSorter.resetSavedOrder(appState.activeMerk);
        renderTable();
        renderCharts();
        showStatus('Urutan outlet berhasil dikembalikan ke default.', 'info');
      }
    });

    // Export Table Layout back to CSV format
    btnExportCsv.addEventListener('click', () => {
      if (!appState.parsedData || !appState.activeMerk) {
        alert('Tidak ada data yang dapat diekspor. Pilih merk terlebih dahulu.');
        return;
      }
      
      let merkData;
      if (appState.activeMerk === 'ALL') {
        merkData = {
          name: 'SEMUA MERK',
          items: {},
          outlets: appState.parsedData.allOutlets
        };
        Object.values(appState.parsedData.merks).forEach(merkObj => {
          Object.assign(merkData.items, merkObj.items);
        });
      } else {
        merkData = appState.parsedData.merks[appState.activeMerk];
      }
      const items = Object.values(merkData.items);
      const outlets = OutletSorter.sortOutlets(merkData.outlets, appState.activeMerk);
      
      // Build Transposed CSV content
      let csvContent = `Kode Item,Nama Item,`;
      
      // Headers (Outlets)
      outlets.forEach(outlet => {
        csvContent += `"${outlet}",`;
      });
      csvContent += `TOTAL\n`;

      // Rows (Items)
      items.forEach(item => {
        csvContent += `"${item.code}","${item.name}",`;
        let total = 0;
        outlets.forEach(outlet => {
          const stock = item.stocks[outlet] || 0;
          total += stock;
          csvContent += `"${stock} PCS",`;
        });
        csvContent += `"${total} PCS"\n`;
      });

      // Add TOTAL summary row
      csvContent += `"TOTAL","TOTAL",`;
      let grandTotal = 0;
      outlets.forEach(outlet => {
        let outletTotal = 0;
        items.forEach(item => {
          outletTotal += item.stocks[outlet] || 0;
        });
        grandTotal += outletTotal;
        csvContent += `"${outletTotal} PCS",`;
      });
      csvContent += `"${grandTotal} PCS"\n`;

      // Download Trigger
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.setAttribute('href', url);
      link.setAttribute('download', `Analisa_Stok_${appState.activeMerk.replace(/\s+/g, '_')}.csv`);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });

    // Export Table Layout to Excel format using SheetJS (XLSX)
    btnExportXlsx.addEventListener('click', () => {
      if (!appState.parsedData || !appState.activeMerk) {
        alert('Tidak ada data yang dapat diekspor. Pilih merk terlebih dahulu.');
        return;
      }

      if (typeof XLSX === 'undefined') {
        alert('Pustaka ekspor Excel gagal dimuat. Harap periksa koneksi internet Anda.');
        return;
      }
      
      let merkData;
      if (appState.activeMerk === 'ALL') {
        merkData = {
          name: 'SEMUA MERK',
          items: {},
          outlets: appState.parsedData.allOutlets
        };
        Object.values(appState.parsedData.merks).forEach(merkObj => {
          Object.assign(merkData.items, merkObj.items);
        });
      } else {
        merkData = appState.parsedData.merks[appState.activeMerk];
      }
      const items = Object.values(merkData.items);
      const outlets = OutletSorter.sortOutlets(merkData.outlets, appState.activeMerk);

      // Create Array of Arrays for SheetJS
      const headerRow = ['Kode Item', 'Nama Item', ...outlets, 'TOTAL'];
      const dataRows = [];

      // Add data rows (convert numbers to float/int so formula functions correctly)
      items.forEach(item => {
        const row = [item.code, item.name];
        let total = 0;
        outlets.forEach(outlet => {
          const stock = item.stocks[outlet] || 0;
          total += stock;
          row.push(stock);
        });
        row.push(total);
        dataRows.push(row);
      });

      // Add TOTAL summary row
      const totalRow = ['TOTAL', 'TOTAL'];
      let grandTotal = 0;
      outlets.forEach(outlet => {
        let outletTotal = 0;
        items.forEach(item => {
          outletTotal += item.stocks[outlet] || 0;
        });
        grandTotal += outletTotal;
        totalRow.push(outletTotal);
      });
      totalRow.push(grandTotal);
      dataRows.push(totalRow);

      const aoaData = [headerRow, ...dataRows];

      // Convert to SheetJS Worksheet
      const worksheet = XLSX.utils.aoa_to_sheet(aoaData);

      // Auto-fit columns based on text length
      const colWidths = headerRow.map((colName, colIdx) => {
        let maxLen = colName.toString().length;
        aoaData.forEach(row => {
          const val = row[colIdx];
          if (val !== undefined && val !== null) {
            const strLen = val.toString().length;
            if (strLen > maxLen) {
              maxLen = strLen;
            }
          }
        });
        // Limit max width to 45 characters, minimum 8 characters
        return { wch: Math.min(Math.max(maxLen + 2, 8), 45) };
      });
      worksheet['!cols'] = colWidths;

      // Set cell styles or formats if needed
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Laporan Stok');

      // Save XLSX file
      const fileName = `Analisa_Stok_${appState.activeMerk.replace(/\s+/g, '_')}.xlsx`;
      XLSX.writeFile(workbook, fileName);
      showStatus(`Tabel berhasil diekspor ke "${fileName}"!`, 'info');
    });

    // Toggle Fullscreen Table Mode
    btnFullscreen.addEventListener('click', () => {
      const tableSection = document.querySelector('.table-section');
      const isFullscreen = tableSection.classList.toggle('fullscreen');
      if (isFullscreen) {
        btnFullscreen.innerHTML = '<i data-lucide="minimize-2" style="width: 14px; height: 14px; display: inline; vertical-align: middle;"></i> Exit Fullscreen';
      } else {
        btnFullscreen.innerHTML = '<i data-lucide="maximize-2" style="width: 14px; height: 14px; display: inline; vertical-align: middle;"></i> Fullscreen';
      }
      lucide.createIcons();
    });

    // Delete Report Date from database
    if (btnDeleteDate) {
      btnDeleteDate.addEventListener('click', async () => {
        if (!appState.currentDate || !appState.isBackendAvailable) return;
        const confirmDelete = confirm(`Apakah Anda yakin ingin menghapus data laporan tanggal ${formatDateDisplay(appState.currentDate)} dari database?`);
        if (!confirmDelete) return;

        try {
          showStatus(`Menghapus data tanggal ${formatDateDisplay(appState.currentDate)}...`, 'info');
          const res = await fetch(`/api/report?date=${encodeURIComponent(appState.currentDate)}`, {
            method: 'DELETE'
          });
          const result = await res.json();
          if (!res.ok || !result.success) throw new Error(result.message || 'Gagal menghapus data');

          showStatus(result.message, 'info');
          // Reload dates
          await checkBackendAndLoad();
        } catch (err) {
          showStatus(`Gagal menghapus: ${err.message}`, 'warning');
        }
      });
    }
  }

  // 11. Toggle Light / Dark Theme
  function setupTheme() {
    const btnThemeToggle = document.getElementById('btn-theme-toggle');
    const themeIconLight = document.getElementById('theme-icon-light');
    const themeIconDark = document.getElementById('theme-icon-dark');
    const themeText = document.getElementById('theme-text');

    // Retrieve saved theme from localStorage, default is dark theme
    const savedTheme = localStorage.getItem('app-theme') || 'dark';
    setTheme(savedTheme);

    btnThemeToggle.addEventListener('click', () => {
      const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      setTheme(newTheme);
    });

    function setTheme(theme) {
      if (theme === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
        themeIconLight.style.display = 'inline-block';
        themeIconDark.style.display = 'none';
        themeText.textContent = 'Mode Terang';
        localStorage.setItem('app-theme', 'light');
      } else {
        document.documentElement.removeAttribute('data-theme');
        themeIconLight.style.display = 'none';
        themeIconDark.style.display = 'inline-block';
        themeText.textContent = 'Mode Gelap';
        localStorage.setItem('app-theme', 'dark');
      }
      
      // Update Chart.js colors if charts are active
      if (appState.parsedData && appState.activeMerk) {
        renderCharts();
      }
    }
  }

  // 12. Setup Database Management Sidebar Drawer
  function setupDatabaseModal() {
    const dbSidebar = document.getElementById('db-sidebar');
    const dbSidebarOverlay = document.getElementById('db-sidebar-overlay');
    const btnCloseSidebar = document.getElementById('btn-close-sidebar');
    const dbStatSize = document.getElementById('db-stat-size');
    const dbStatReports = document.getElementById('db-stat-reports');
    const dbStatRecords = document.getElementById('db-stat-records');
    const dbStatRange = document.getElementById('db-stat-range');
    const dbReportsList = document.getElementById('db-reports-list');
    const btnClearDb = document.getElementById('btn-clear-db');
    const restoreFileInput = document.getElementById('restore-file-input');

    if (!btnDbManage || !dbSidebar) return;

    btnDbManage.addEventListener('click', () => {
      openSidebar();
    });

    if (btnCloseSidebar) {
      btnCloseSidebar.addEventListener('click', () => {
        closeSidebar();
      });
    }

    if (dbSidebarOverlay) {
      dbSidebarOverlay.addEventListener('click', () => {
        closeSidebar();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && dbSidebar.classList.contains('active')) {
        closeSidebar();
      }
    });

    function openSidebar() {
      if (!appState.isBackendAvailable) {
        alert('Fitur manajemen database hanya aktif saat server backend berjalan (port 3000). Silakan jalankan "npm start" atau deploy di ZimaOS.');
        return;
      }
      if (dbSidebarOverlay) dbSidebarOverlay.style.display = 'block';
      setTimeout(() => {
        if (dbSidebarOverlay) dbSidebarOverlay.classList.add('active');
        dbSidebar.classList.add('active');
      }, 10);
      loadSidebarData();
    }

    function closeSidebar() {
      if (dbSidebarOverlay) dbSidebarOverlay.classList.remove('active');
      dbSidebar.classList.remove('active');
      setTimeout(() => {
        if (dbSidebarOverlay) dbSidebarOverlay.style.display = 'none';
      }, 300);
    }

    async function loadSidebarData() {
      // 1. Fetch Database Info
      try {
        const res = await fetch('/api/database/info');
        if (res.ok) {
          const json = await res.json();
          if (json.success && json.info) {
            dbStatSize.textContent = json.info.fileSizeFormatted;
            dbStatReports.textContent = json.info.totalReports;
            dbStatRecords.textContent = json.info.totalRecords.toLocaleString('id-ID');
            dbStatRange.textContent = json.info.totalReports > 0
              ? `${formatDateDisplay(json.info.firstDate)} s/d ${formatDateDisplay(json.info.latestDate)}`
              : '-';
          }
        }
      } catch (e) {
        console.warn('Gagal memuat info database', e);
      }

      // 2. Fetch Dates List
      try {
        dbReportsList.innerHTML = '<div style="text-align: center; padding: 25px 10px; color: var(--text-muted);">Memuat riwayat...</div>';
        const res = await fetch('/api/dates');
        if (res.ok) {
          const json = await res.json();
          if (json.success && Array.isArray(json.dates)) {
            if (json.dates.length === 0) {
              dbReportsList.innerHTML = '<div style="text-align: center; padding: 30px 10px; color: var(--text-muted); font-style: italic;">Belum ada laporan yang tersimpan di database. Silakan unggah file CSV.</div>';
              return;
            }

            dbReportsList.innerHTML = '';
            json.dates.forEach(d => {
              const card = document.createElement('div');
              card.className = 'report-item-card';
              const dateDisplay = formatDateDisplay(d.report_date);
              const totalStockFmt = (d.total_stock || 0).toLocaleString('id-ID') + ' PCS';
              const createdDate = d.created_at ? new Date(d.created_at).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' }) : '-';

              card.innerHTML = `
                <div class="report-item-header">
                  <div class="report-item-date">
                    <i data-lucide="calendar" style="width: 14px; height: 14px;"></i> ${dateDisplay}
                  </div>
                  <span class="badge-stock">${totalStockFmt}</span>
                </div>
                <div class="report-item-meta">
                  <span>${escapeHtml(d.filename || 'Laporan')}</span> &bull; <span>${d.total_merks || 0} merk / ${d.total_items || 0} item</span>
                </div>
                <div class="report-item-actions">
                  <button class="btn-mini-primary" data-action="view" data-date="${d.report_date}">
                    <i data-lucide="eye" style="width: 13px; height: 13px;"></i> Buka di Tabel
                  </button>
                  <button class="btn-mini-danger" data-action="delete" data-date="${d.report_date}">
                    <i data-lucide="trash-2" style="width: 13px; height: 13px;"></i> Hapus
                  </button>
                </div>
              `;
              dbReportsList.appendChild(card);
            });

            lucide.createIcons();

            // Bind action buttons
            dbReportsList.querySelectorAll('button[data-action="view"]').forEach(btn => {
              btn.addEventListener('click', () => {
                const date = btn.getAttribute('data-date');
                closeSidebar();
                loadStockByDate(date);
              });
            });

            dbReportsList.querySelectorAll('button[data-action="delete"]').forEach(btn => {
              btn.addEventListener('click', async () => {
                const date = btn.getAttribute('data-date');
                if (confirm(`Hapus laporan tanggal ${formatDateDisplay(date)} dari database?`)) {
                  try {
                    const delRes = await fetch(`/api/report?date=${encodeURIComponent(date)}`, { method: 'DELETE' });
                    const delJson = await delRes.json();
                    if (delJson.success) {
                      loadSidebarData();
                      checkBackendAndLoad();
                    } else {
                      alert(delJson.message || 'Gagal menghapus');
                    }
                  } catch (err) {
                    alert('Error: ' + err.message);
                  }
                }
              });
            });
          }
        }
      } catch (e) {
        dbReportsList.innerHTML = '<div style="text-align: center; color: var(--status-danger); padding: 20px;">Gagal memuat daftar riwayat.</div>';
      }
    }

    // Clear Database Handler
    if (btnClearDb) {
      btnClearDb.addEventListener('click', async () => {
        const confirmPrompt = prompt('PERINGATAN: Seluruh data laporan harian akan dihapus permanen!\n\nKetik kata "HAPUS" untuk mengonfirmasi:');
        if (confirmPrompt !== 'HAPUS') {
          if (confirmPrompt !== null) alert('Konfirmasi dibatalkan. Kata kunci tidak cocok.');
          return;
        }

        try {
          const res = await fetch('/api/database/clear', { method: 'POST' });
          const json = await res.json();
          if (json.success) {
            alert('Database berhasil dikosongkan!');
            closeSidebar();
            checkBackendAndLoad();
          } else {
            alert(json.message || 'Gagal mengosongkan database');
          }
        } catch (err) {
          alert('Error: ' + err.message);
        }
      });
    }

    // Restore Database Handler
    if (restoreFileInput) {
      restoreFileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        if (!file.name.endsWith('.db')) {
          alert('Format file tidak didukung! Harap pilih file database SQLite dengan ekstensi .db');
          restoreFileInput.value = '';
          return;
        }

        const confirmRestore = confirm(`Apakah Anda yakin ingin memulihkan database dari "${file.name}"?\nData saat ini akan ditimpa dengan data cadangan ini.`);
        if (!confirmRestore) {
          restoreFileInput.value = '';
          return;
        }

        try {
          showStatus('Memulihkan database dari cadangan...', 'info');
          const buffer = await file.arrayBuffer();
          const res = await fetch('/api/database/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: buffer
          });
          const json = await res.json();
          if (res.ok && json.success) {
            alert('Database berhasil dipulihkan!');
            closeSidebar();
            checkBackendAndLoad();
          } else {
            alert(json.message || 'Gagal memulihkan database');
          }
        } catch (err) {
          alert('Gagal restore: ' + err.message);
        } finally {
          restoreFileInput.value = '';
        }
      });
    }
  }

  // ============================================================
  // TAB NAVIGATION & MULTI-MODULE CONTROLLER
  // ============================================================
  function setupTabs() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabPanels = document.querySelectorAll('.tab-panel');
    const titleEl = document.getElementById('active-view-title');
    const appSidebar = document.getElementById('app-sidebar');
    const mobileOverlay = document.getElementById('sidebar-mobile-overlay');

    const tabTitles = {
      'stock-matrix': 'Matriks Stok Cabang',
      'rebalance': 'Saran Transfer Cabang',
      'coverage': 'Ketahanan Stok (DoC)',
      'po-planner': 'Rencana Belanja (PO)'
    };

    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetTab = btn.getAttribute('data-tab');
        
        tabBtns.forEach(b => b.classList.remove('active'));
        tabPanels.forEach(p => p.classList.remove('active'));

        btn.classList.add('active');
        const activePanel = document.getElementById(`tab-panel-${targetTab}`);
        if (activePanel) activePanel.classList.add('active');

        // Update active page title / breadcrumb
        if (titleEl && tabTitles[targetTab]) {
          titleEl.textContent = tabTitles[targetTab];
        }

        // Close mobile sidebar if open
        if (appSidebar && appSidebar.classList.contains('mobile-open')) {
          appSidebar.classList.remove('mobile-open');
          if (mobileOverlay) {
            mobileOverlay.classList.remove('active');
            setTimeout(() => { mobileOverlay.style.display = 'none'; }, 250);
          }
        }

        // Lazy load data for respective tab
        if (targetTab === 'rebalance') {
          loadRebalanceData();
        } else if (targetTab === 'coverage') {
          loadCoverageData();
        } else if (targetTab === 'po-planner') {
          loadPOData();
        } else if (targetTab === 'import-center') {
          loadImportBatches();
        }

        if (window.lucide) {
          setTimeout(() => lucide.createIcons(), 50);
        }
      });
    });
  }

  // ============================================================
  // LEFT SIDEBAR CONTROLLER (COLLAPSE / EXPAND / MOBILE)
  // ============================================================
  function setupSidebar() {
    const appSidebar = document.getElementById('app-sidebar');
    const btnToggle = document.getElementById('btn-toggle-sidebar');
    const btnMobile = document.getElementById('btn-mobile-sidebar');
    const mobileOverlay = document.getElementById('sidebar-mobile-overlay');
    const iconCollapse = document.getElementById('icon-collapse-sidebar');

    function updateCollapseIcon(isCollapsed) {
      if (!iconCollapse) return;
      if (isCollapsed) {
        iconCollapse.setAttribute('data-lucide', 'panel-left-open');
        if (btnToggle) btnToggle.setAttribute('title', 'Lebarkan Menu');
      } else {
        iconCollapse.setAttribute('data-lucide', 'panel-left-close');
        if (btnToggle) btnToggle.setAttribute('title', 'Ciutkan Menu');
      }
    }

    // 1. Restore collapsed state from localStorage on load
    const savedCollapsed = localStorage.getItem('app_sidebar_collapsed');
    if (savedCollapsed === '1' && appSidebar && window.innerWidth > 1024) {
      appSidebar.classList.add('collapsed');
      updateCollapseIcon(true);
    }

    // 2. Desktop Collapse / Expand toggle
    if (btnToggle && appSidebar) {
      btnToggle.addEventListener('click', () => {
        const isCollapsed = appSidebar.classList.toggle('collapsed');
        updateCollapseIcon(isCollapsed);
        localStorage.setItem('app_sidebar_collapsed', isCollapsed ? '1' : '0');
        if (window.lucide) lucide.createIcons();
      });
    }

    // 3. Mobile Sidebar Drawer toggle
    if (btnMobile && appSidebar) {
      btnMobile.addEventListener('click', () => {
        const isOpen = appSidebar.classList.toggle('mobile-open');
        if (mobileOverlay) {
          mobileOverlay.style.display = isOpen ? 'block' : 'none';
          if (isOpen) {
            setTimeout(() => mobileOverlay.classList.add('active'), 10);
          } else {
            mobileOverlay.classList.remove('active');
          }
        }
      });
    }

    if (mobileOverlay && appSidebar) {
      mobileOverlay.addEventListener('click', () => {
        appSidebar.classList.remove('mobile-open');
        mobileOverlay.classList.remove('active');
        setTimeout(() => {
          mobileOverlay.style.display = 'none';
        }, 250);
      });
    }
  }

    // ============================================================
    // IMPORT DATABASE SIDEBAR DRAWER CONTROLLER
    // ============================================================
    const importSidebar = document.getElementById('import-sidebar');
    const importSidebarOverlay = document.getElementById('import-sidebar-overlay');
    const btnCloseImportSidebar = document.getElementById('btn-close-import-sidebar');
    const btnHeaderImport = document.getElementById('btn-header-import');
    const btnSidebarImport = document.getElementById('btn-sidebar-import');

    function openImportSidebar() {
      if (!importSidebar) return;
      if (importSidebarOverlay) importSidebarOverlay.style.display = 'block';
      setTimeout(() => {
        if (importSidebarOverlay) importSidebarOverlay.classList.add('active');
        importSidebar.classList.add('active');
      }, 10);
      loadImportBatches();
      if (window.lucide) {
        setTimeout(() => lucide.createIcons(), 50);
      }
    }

    function closeImportSidebar() {
      if (!importSidebar) return;
      if (importSidebarOverlay) importSidebarOverlay.classList.remove('active');
      importSidebar.classList.remove('active');
      setTimeout(() => {
        if (importSidebarOverlay) importSidebarOverlay.style.display = 'none';
      }, 300);
    }

    if (btnHeaderImport) {
      btnHeaderImport.addEventListener('click', openImportSidebar);
    }

    if (btnSidebarImport) {
      btnSidebarImport.addEventListener('click', () => {
        const btnCloseDbSidebar = document.getElementById('btn-close-sidebar');
        if (btnCloseDbSidebar) btnCloseDbSidebar.click();
        openImportSidebar();
      });
    }

    if (btnCloseImportSidebar) {
      btnCloseImportSidebar.addEventListener('click', closeImportSidebar);
    }

    if (importSidebarOverlay) {
      importSidebarOverlay.addEventListener('click', closeImportSidebar);
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && importSidebar && importSidebar.classList.contains('active')) {
        closeImportSidebar();
      }
    });

  // ============================================================
  // TAB 2: SMART REBALANCING (TRANSFER ANTAR-CABANG)
  // ============================================================
  let rebalanceRecommendations = [];

  async function loadRebalanceData() {
    const tableBody = document.getElementById('rebalance-table-body');
    if (!tableBody) return;

    try {
      tableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 40px; color: var(--text-muted);"><i data-lucide="loader-2" class="spin"></i> Memuat rekomendasi transfer antar-cabang...</td></tr>`;
      if (window.lucide) lucide.createIcons();

      const url = `/api/analytics/rebalancing?stockDate=${encodeURIComponent(appState.currentDate || '')}`;
      const res = await fetch(url);
      const json = await res.json();

      if (!json.success || !Array.isArray(json.recommendations)) {
        throw new Error(json.message || 'Gagal mengambil data rekomendasi');
      }

      rebalanceRecommendations = json.recommendations;

      // Update badge in tab button
      const badge = document.getElementById('badge-transfer-count');
      if (badge) badge.textContent = json.count || 0;

      // Populate merk filter
      populateRebalanceMerkFilter(rebalanceRecommendations);

      // Render table & KPI
      renderRebalanceTable();
    } catch (err) {
      console.error('Rebalance load error:', err);
      tableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 40px; color: var(--status-danger);">Gagal memuat rekomendasi: ${err.message}</td></tr>`;
    }
  }

  function populateRebalanceMerkFilter(recs) {
    const filter = document.getElementById('rebalance-merk-filter');
    if (!filter) return;
    const currentVal = filter.value;
    const merks = new Set(recs.map(r => r.merk).filter(Boolean));

    filter.innerHTML = '<option value="ALL">-- Semua Merk --</option>';
    Array.from(merks).sort().forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      filter.appendChild(opt);
    });
    if (merks.has(currentVal)) filter.value = currentVal;
  }

  function renderRebalanceTable() {
    const tableBody = document.getElementById('rebalance-table-body');
    if (!tableBody) return;

    const urgencyFilter = document.getElementById('rebalance-urgency-filter')?.value || 'ALL';
    const merkFilter = document.getElementById('rebalance-merk-filter')?.value || 'ALL';
    const query = (document.getElementById('rebalance-search-input')?.value || '').toLowerCase().trim();

    let filtered = rebalanceRecommendations.filter(r => {
      if (urgencyFilter !== 'ALL' && r.urgency !== urgencyFilter) return false;
      if (merkFilter !== 'ALL' && r.merk !== merkFilter) return false;
      if (query) {
        const matchItem = (r.itemName || '').toLowerCase().includes(query) || (r.itemCode || '').includes(query);
        const matchFrom = (r.fromOutlet || '').toLowerCase().includes(query);
        const matchTo = (r.toOutlet || '').toLowerCase().includes(query);
        if (!matchItem && !matchFrom && !matchTo) return false;
      }
      return true;
    });

    // Update KPI cards
    const totalQty = filtered.reduce((sum, r) => sum + (r.qty || 0), 0);
    const targetOutlets = new Set(filtered.map(r => r.toOutlet));
    const urgentCount = filtered.filter(r => r.urgency === 'HIGH').length;

    const statRoutes = document.getElementById('stat-rebalance-routes');
    const statQty = document.getElementById('stat-rebalance-qty');
    const statOutlets = document.getElementById('stat-rebalance-outlets');
    const statUrgent = document.getElementById('stat-rebalance-urgent');

    if (statRoutes) statRoutes.textContent = filtered.length;
    if (statQty) statQty.textContent = totalQty.toLocaleString('id-ID');
    if (statOutlets) statOutlets.textContent = targetOutlets.size;
    if (statUrgent) statUrgent.textContent = urgentCount;

    if (filtered.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 40px; color: var(--text-muted);">Tidak ada rekomendasi transfer yang sesuai dengan filter.</td></tr>`;
      return;
    }

    let rowsHtml = '';
    filtered.forEach((r, idx) => {
      const urgencyBadge = r.urgency === 'HIGH'
        ? `<span class="status-badge badge-high-urgency">🔴 MENDESAK</span>`
        : `<span class="status-badge badge-med-urgency">🟡 WASPADA</span>`;

      rowsHtml += `
        <tr>
          <td style="text-align: center; color: var(--text-muted);">${idx + 1}</td>
          <td>
            <div style="font-weight: 700; color: var(--text-primary);">${escapeHtml(r.itemName)}</div>
            <div style="font-size: 11px; color: var(--text-secondary); font-family: monospace;">${r.itemCode}</div>
          </td>
          <td><span style="font-size: 11.5px; color: var(--accent-cyan);">${escapeHtml(r.merk || '-')}</span></td>
          <td><span class="transfer-from-tag">${escapeHtml(r.fromOutlet)}</span></td>
          <td><span class="transfer-to-tag">${escapeHtml(r.toOutlet)}</span></td>
          <td style="text-align: right; font-weight: 800; color: var(--accent-cyan); font-size: 14px;">${r.qty} <span style="font-size: 11px; font-weight: 500;">PCS</span></td>
          <td style="text-align: center;">${urgencyBadge}</td>
          <td style="font-size: 11.5px; color: var(--text-secondary);">${escapeHtml(r.reason)}</td>
        </tr>
      `;
    });

    tableBody.innerHTML = rowsHtml;
  }

  function setupRebalanceControls() {
    const urgencyFilter = document.getElementById('rebalance-urgency-filter');
    const merkFilter = document.getElementById('rebalance-merk-filter');
    const searchInput = document.getElementById('rebalance-search-input');
    const btnExport = document.getElementById('btn-export-rebalance');

    if (urgencyFilter) urgencyFilter.addEventListener('change', renderRebalanceTable);
    if (merkFilter) merkFilter.addEventListener('change', renderRebalanceTable);
    if (searchInput) searchInput.addEventListener('input', renderRebalanceTable);

    if (btnExport) {
      btnExport.addEventListener('click', () => {
        if (!rebalanceRecommendations || rebalanceRecommendations.length === 0) {
          alert('Tidak ada data rekomendasi transfer untuk diekspor.');
          return;
        }

        const dataToExport = rebalanceRecommendations.map((r, i) => ({
          'No': i + 1,
          'Kode Item': r.itemCode,
          'Nama Barang': r.itemName,
          'Merk': r.merk,
          'Dari Cabang (Sumber)': r.fromOutlet,
          'Ke Cabang (Tujuan)': r.toOutlet,
          'Qty Transfer (PCS)': r.qty,
          'Tingkat Urgensi': r.urgency === 'HIGH' ? 'Mendesak' : 'Waspada',
          'Alasan Rekomendasi': r.reason
        }));

        const ws = XLSX.utils.json_to_sheet(dataToExport);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Slip_Transfer');
        const filename = `Rekomendasi_Transfer_Cabang_${appState.currentDate || 'Aktif'}.xlsx`;
        XLSX.writeFile(wb, filename);
      });
    }
  }

  // ============================================================
  // TAB 3: DAYS OF COVERAGE (DoC) ANALYTICS
  // ============================================================
  let coverageData = null;

  async function loadCoverageData() {
    const tableBody = document.getElementById('coverage-table-body');
    if (!tableBody) return;

    try {
      tableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 40px; color: var(--text-muted);"><i data-lucide="loader-2" class="spin"></i> Memuat analisa ketahanan stok...</td></tr>`;
      if (window.lucide) lucide.createIcons();

      const url = `/api/analytics/integrated?stockDate=${encodeURIComponent(appState.currentDate || '')}`;
      const res = await fetch(url);
      const json = await res.json();

      if (!json.success || !json.data) throw new Error(json.message || 'Gagal mengambil data ketahanan');
      coverageData = json.data;
      renderCoverageTable();
    } catch (err) {
      console.error('Coverage load error:', err);
      tableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 40px; color: var(--status-danger);">Gagal memuat ketahanan: ${err.message}</td></tr>`;
    }
  }

  function renderCoverageTable() {
    const tableBody = document.getElementById('coverage-table-body');
    if (!tableBody || !coverageData || !coverageData.items) return;

    const statusFilter = document.getElementById('coverage-status-filter')?.value || 'ALL';
    const query = (document.getElementById('coverage-search-input')?.value || '').toLowerCase().trim();

    const items = Object.values(coverageData.items).filter(item => {
      if (query && !item.name.toLowerCase().includes(query) && !item.code.includes(query)) return false;

      if (statusFilter !== 'ALL') {
        const hasMatchingOutlet = Object.values(item.outlets).some(o => o.status === statusFilter);
        if (!hasMatchingOutlet) return false;
      }
      return true;
    });

    if (items.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 40px; color: var(--text-muted);">Tidak ada data barang yang sesuai filter ketahanan.</td></tr>`;
      return;
    }

    let rowsHtml = '';
    items.forEach((item, idx) => {
      const criticalOutlets = [];
      const overstockOutlets = [];

      Object.entries(item.outlets).forEach(([outlet, out]) => {
        if (out.status === 'OUT_OF_STOCK') {
          criticalOutlets.push(`<span class="status-badge badge-critical">${outlet}: KOSONG (${out.ads}/hr)</span>`);
        } else if (out.status === 'CRITICAL') {
          criticalOutlets.push(`<span class="status-badge badge-critical">${outlet}: ${out.doc} hr</span>`);
        } else if (out.status === 'OVERSTOCK') {
          overstockOutlets.push(`<span class="status-badge badge-overstock">${outlet}: ${out.doc} hr (${out.stock} pcs)</span>`);
        }
      });

      let outletDetails = '';
      if (criticalOutlets.length > 0) {
        outletDetails += `<div style="margin-bottom: 4px;"><strong>Kritis:</strong> ${criticalOutlets.slice(0, 4).join(' ')} ${criticalOutlets.length > 4 ? `+${criticalOutlets.length - 4}` : ''}</div>`;
      }
      if (overstockOutlets.length > 0) {
        outletDetails += `<div><strong>Overstock:</strong> ${overstockOutlets.slice(0, 4).join(' ')} ${overstockOutlets.length > 4 ? `+${overstockOutlets.length - 4}` : ''}</div>`;
      }
      if (!outletDetails) outletDetails = '<span style="color: var(--text-muted); font-size: 11px;">Kondisi Normal / Seimbang</span>';

      const docDisplay = item.globalDoC >= 999 ? '∞' : `${item.globalDoC} hr`;

      rowsHtml += `
        <tr>
          <td style="text-align: center; color: var(--text-muted);">${idx + 1}</td>
          <td style="font-family: monospace; font-size: 12px;">${item.code}</td>
          <td style="font-weight: 700;">${escapeHtml(item.name)}</td>
          <td><span style="font-size: 11.5px; color: var(--accent-cyan);">${escapeHtml(item.merk || '-')}</span></td>
          <td style="text-align: right; font-weight: 700;">${item.totalStock.toLocaleString('id-ID')}</td>
          <td style="text-align: right; color: var(--status-warning); font-weight: 700;">${item.totalADS}</td>
          <td style="text-align: right; font-weight: 800; color: ${item.globalDoC < 3 ? 'var(--status-danger)' : 'var(--status-success)'};">${docDisplay}</td>
          <td style="font-size: 11.5px;">${outletDetails}</td>
        </tr>
      `;
    });

    tableBody.innerHTML = rowsHtml;
  }

  function setupCoverageControls() {
    const statusFilter = document.getElementById('coverage-status-filter');
    const searchInput = document.getElementById('coverage-search-input');
    const btnExport = document.getElementById('btn-export-coverage');

    if (statusFilter) statusFilter.addEventListener('change', renderCoverageTable);
    if (searchInput) searchInput.addEventListener('input', renderCoverageTable);

    if (btnExport) {
      btnExport.addEventListener('click', () => {
        if (!coverageData || !coverageData.items) {
          alert('Tidak ada data ketahanan stok untuk diekspor.');
          return;
        }

        const dataToExport = Object.values(coverageData.items).map((item, i) => ({
          'No': i + 1,
          'Kode Item': item.code,
          'Nama Barang': item.name,
          'Merk': item.merk,
          'Total Stok (PCS)': item.totalStock,
          'Penjualan Harian (ADS)': item.totalADS,
          'Ketahanan Jaringan (Hari)': item.globalDoC >= 999 ? 'Tidak Ada Penjualan' : item.globalDoC
        }));

        const ws = XLSX.utils.json_to_sheet(dataToExport);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Ketahanan_Stok');
        const filename = `Analisa_Ketahanan_Stok_${appState.currentDate || 'Aktif'}.xlsx`;
        XLSX.writeFile(wb, filename);
      });
    }
  }

  // ============================================================
  // TAB 4: PO PLANNER (RENCANA PEMBELIAN BARU)
  // ============================================================
  let poSuggestions = [];

  async function loadPOData() {
    const tableBody = document.getElementById('po-table-body');
    if (!tableBody) return;

    try {
      tableBody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 40px; color: var(--text-muted);"><i data-lucide="loader-2" class="spin"></i> Memuat rekomendasi PO belanja...</td></tr>`;
      if (window.lucide) lucide.createIcons();

      const url = `/api/analytics/po?stockDate=${encodeURIComponent(appState.currentDate || '')}`;
      const res = await fetch(url);
      const json = await res.json();

      if (!json.success || !Array.isArray(json.suggestions)) throw new Error(json.message || 'Gagal memuat PO');

      poSuggestions = json.suggestions;

      const badge = document.getElementById('badge-po-count');
      if (badge) badge.textContent = json.count || 0;

      populatePOMerkFilter(poSuggestions);
      renderPOTable();
    } catch (err) {
      console.error('PO load error:', err);
      tableBody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 40px; color: var(--status-danger);">Gagal memuat rencana belanja: ${err.message}</td></tr>`;
    }
  }

  function populatePOMerkFilter(suggestions) {
    const filter = document.getElementById('po-merk-filter');
    if (!filter) return;
    const currentVal = filter.value;
    const merks = new Set(suggestions.map(s => s.merk).filter(Boolean));

    filter.innerHTML = '<option value="ALL">-- Semua Merk --</option>';
    Array.from(merks).sort().forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      filter.appendChild(opt);
    });
    if (merks.has(currentVal)) filter.value = currentVal;
  }

  function renderPOTable() {
    const tableBody = document.getElementById('po-table-body');
    if (!tableBody) return;

    const merkFilter = document.getElementById('po-merk-filter')?.value || 'ALL';
    const query = (document.getElementById('po-search-input')?.value || '').toLowerCase().trim();

    const filtered = poSuggestions.filter(s => {
      if (merkFilter !== 'ALL' && s.merk !== merkFilter) return false;
      if (query && !s.itemName.toLowerCase().includes(query) && !s.itemCode.includes(query)) return false;
      return true;
    });

    const totalOrderPcs = filtered.reduce((sum, s) => sum + (s.suggestedQty || 0), 0);
    const urgentCount = filtered.filter(s => s.urgency === 'HIGH').length;

    const statItems = document.getElementById('stat-po-items');
    const statQty = document.getElementById('stat-po-qty');
    const statUrgent = document.getElementById('stat-po-urgent');

    if (statItems) statItems.textContent = filtered.length;
    if (statQty) statQty.textContent = totalOrderPcs.toLocaleString('id-ID');
    if (statUrgent) statUrgent.textContent = urgentCount;

    if (filtered.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 40px; color: var(--text-muted);">Seluruh stok jaringan masih di atas batas aman. Tidak ada order yang diperlukan!</td></tr>`;
      return;
    }

    let rowsHtml = '';
    filtered.forEach((s, idx) => {
      const urgencyBadge = s.urgency === 'HIGH'
        ? `<span class="status-badge badge-high-urgency">🔴 MENDESAK</span>`
        : `<span class="status-badge badge-med-urgency">🟡 NORMAL</span>`;

      rowsHtml += `
        <tr>
          <td style="text-align: center; color: var(--text-muted);">${idx + 1}</td>
          <td style="font-family: monospace; font-size: 12px;">${s.itemCode}</td>
          <td style="font-weight: 700;">${escapeHtml(s.itemName)}</td>
          <td><span style="font-size: 11.5px; color: var(--accent-cyan);">${escapeHtml(s.merk || '-')}</span></td>
          <td style="text-align: right; font-weight: 700;">${s.globalStock}</td>
          <td style="text-align: right; color: var(--status-warning); font-weight: 700;">${s.globalADS}</td>
          <td style="text-align: right; font-weight: 700; color: ${s.daysLeft < 3 ? 'var(--status-danger)' : 'var(--text-primary)'};">${s.daysLeft} hr</td>
          <td style="text-align: right; color: var(--text-secondary);">${s.reorderPoint}</td>
          <td style="text-align: right; font-weight: 800; color: var(--accent-cyan); font-size: 14px;">${s.suggestedQty} <span style="font-size: 11px; font-weight: 500;">PCS</span></td>
          <td style="text-align: center;">${urgencyBadge}</td>
        </tr>
      `;
    });

    tableBody.innerHTML = rowsHtml;
  }

  function setupPOControls() {
    const merkFilter = document.getElementById('po-merk-filter');
    const searchInput = document.getElementById('po-search-input');
    const btnExport = document.getElementById('btn-export-po');

    if (merkFilter) merkFilter.addEventListener('change', renderPOTable);
    if (searchInput) searchInput.addEventListener('input', renderPOTable);

    if (btnExport) {
      btnExport.addEventListener('click', () => {
        if (!poSuggestions || poSuggestions.length === 0) {
          alert('Tidak ada saran PO untuk diekspor.');
          return;
        }

        const dataToExport = poSuggestions.map((s, i) => ({
          'No': i + 1,
          'Kode Item': s.itemCode,
          'Nama Barang': s.itemName,
          'Merk': s.merk,
          'Stok Jaringan Saat Ini': s.globalStock,
          'Penjualan/Hari (ADS)': s.globalADS,
          'Sisa Ketahanan (Hari)': s.daysLeft,
          'Titik Pesan (ROP)': s.reorderPoint,
          'Target Stok Jaringan': s.targetStock,
          'Saran Order (PO Qty)': s.suggestedQty,
          'Tingkat Urgensi': s.urgency === 'HIGH' ? 'Mendesak' : 'Normal'
        }));

        const ws = XLSX.utils.json_to_sheet(dataToExport);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Draft_PO');
        const filename = `Draft_PO_Pembelian_${appState.currentDate || 'Aktif'}.xlsx`;
        XLSX.writeFile(wb, filename);
      });
    }
  }

  // ============================================================
  // TAB 5: MULTI-TYPE IMPORT CENTER
  // ============================================================
  function setupImportCenter() {
    setupSpecificDropzone('dropzone-stock', 'input-file-stock', '/api/upload', 'stok');
    setupSpecificDropzone('dropzone-sales', 'input-file-sales', '/api/upload-sales', 'penjualan');
    setupSpecificDropzone('dropzone-purchases', 'input-file-purchases', '/api/upload-purchases', 'pembelian');
    setupSpecificDropzone('dropzone-auto', 'input-file-auto', '/api/upload-auto', 'otomatis');
  }

  function setupSpecificDropzone(dropzoneId, inputId, endpoint, label) {
    const zone = document.getElementById(dropzoneId);
    const input = document.getElementById(inputId);
    if (!zone || !input) return;

    zone.addEventListener('click', () => input.click());

    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.style.borderColor = 'var(--accent-cyan)';
    });

    zone.addEventListener('dragleave', () => {
      zone.style.borderColor = '';
    });

    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.style.borderColor = '';
      if (e.dataTransfer.files.length > 0) {
        uploadSpecificFile(e.dataTransfer.files[0], endpoint, label);
      }
    });

    input.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        uploadSpecificFile(e.target.files[0], endpoint, label);
        input.value = '';
      }
    });
  }

  async function uploadSpecificFile(file, endpoint, label) {
    showStatus(`Mengunggah berkas ${label}: "${file.name}"...`, 'info');

    const reader = new FileReader();
    const isBinaryExcel = file.name.endsWith('.xls') || file.name.endsWith('.xlsx');

    reader.onload = async (e) => {
      try {
        let payload = { filename: file.name };

        if (isBinaryExcel) {
          payload.fileBase64 = e.target.result;
        } else {
          payload.csvText = e.target.result;
        }

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json.message || 'Gagal menyimpan ke database');
        }

        showStatus(`Sukses: ${json.message}`, 'success');
        alert(json.message);

        // Refresh all analytics & reports
        checkBackendAndLoad();
        loadImportBatches();
        loadRebalanceData();
        loadPOData();
      } catch (err) {
        console.error('Upload error:', err);
        showStatus(`Gagal unggah berkas: ${err.message}`, 'warning');
        alert('Gagal memproses berkas: ' + err.message);
      }
    };

    if (isBinaryExcel) {
      reader.readAsDataURL(file);
    } else {
      reader.readAsText(file);
    }
  }

  async function loadImportBatches() {
    const salesContainer = document.getElementById('import-history-sales');
    const purchContainer = document.getElementById('import-history-purchases');

    // 1. Sales Batches
    if (salesContainer) {
      try {
        const res = await fetch('/api/sales/batches');
        const json = await res.json();
        if (json.success && json.batches.length > 0) {
          salesContainer.innerHTML = json.batches.map(b => `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: rgba(255,255,255,0.03); border-radius: 8px; margin-bottom: 8px; font-size: 12px;">
              <div>
                <strong style="color: var(--text-primary);">${b.batch_date}</strong>
                <span style="color: var(--text-secondary); margin-left: 8px;">(${b.total_rows.toLocaleString('id-ID')} transaksi, ${b.total_qty.toLocaleString('id-ID')} pcs)</span>
                <div style="color: var(--text-muted); font-size: 11px;">Berkas: ${escapeHtml(b.filename || '-')}</div>
              </div>
              <button class="btn-mini-danger" style="padding: 4px 8px; font-size: 11px;" onclick="window._deleteBatch('sales', '${b.batch_date}')">
                Hapus
              </button>
            </div>
          `).join('');
        } else {
          salesContainer.innerHTML = '<p style="color: var(--text-muted); font-size: 12px;">Belum ada riwayat penjualan yang diimpor.</p>';
        }
      } catch (e) {
        salesContainer.innerHTML = `<p style="color: var(--status-danger); font-size: 12px;">Gagal memuat: ${e.message}</p>`;
      }
    }

    // 2. Purchases Batches
    if (purchContainer) {
      try {
        const res = await fetch('/api/purchases/batches');
        const json = await res.json();
        if (json.success && json.batches.length > 0) {
          purchContainer.innerHTML = json.batches.map(b => `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: rgba(255,255,255,0.03); border-radius: 8px; margin-bottom: 8px; font-size: 12px;">
              <div>
                <strong style="color: var(--text-primary);">${b.batch_date}</strong>
                <span style="color: var(--text-secondary); margin-left: 8px;">(${b.total_rows.toLocaleString('id-ID')} baris, ${b.total_qty.toLocaleString('id-ID')} pcs)</span>
                <div style="color: var(--text-muted); font-size: 11px;">Berkas: ${escapeHtml(b.filename || '-')}</div>
              </div>
              <button class="btn-mini-danger" style="padding: 4px 8px; font-size: 11px;" onclick="window._deleteBatch('purchases', '${b.batch_date}')">
                Hapus
              </button>
            </div>
          `).join('');
        } else {
          purchContainer.innerHTML = '<p style="color: var(--text-muted); font-size: 12px;">Belum ada riwayat pembelian yang diimpor.</p>';
        }
      } catch (e) {
        purchContainer.innerHTML = `<p style="color: var(--status-danger); font-size: 12px;">Gagal memuat: ${e.message}</p>`;
      }
    }
  }

  // Global batch deletion helper
  window._deleteBatch = async function(type, date) {
    if (!confirm(`Hapus batch ${type} untuk tanggal ${date}?`)) return;
    try {
      const endpoint = type === 'sales' ? `/api/sales?date=${date}` : `/api/purchases?date=${date}`;
      const res = await fetch(endpoint, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        alert(json.message);
        loadImportBatches();
        loadRebalanceData();
        loadPOData();
      } else {
        alert(json.message || 'Gagal menghapus batch');
      }
    } catch (e) {
      alert('Error: ' + e.message);
    }
  };
});

