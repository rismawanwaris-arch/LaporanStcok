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
  // Virtualized stock table state (see renderTable/renderVisibleRows).
  // VT_ROW_HEIGHT is a fixed estimate matching the row's CSS (4px td padding
  // top/bottom + a 14px item-name line + an 11px code line, both at the
  // page's 1.6 line-height) — exact per-row measurement isn't needed since a
  // buffer of extra rows is rendered above/below the viewport to absorb it.
  const VT_ROW_HEIGHT = 48;
  const VT_BUFFER_ROWS = 8;

  // Column-sort state for every table (tableBodyId -> { key, dir }); see
  // applyColumnSort/initSortableTable below. Declared here (ahead of init())
  // since init() synchronously wires each tab's sortable headers.
  const columnSortState = {};

  let virtualTable = {
    items: [],
    filteredItems: [],
    outlets: [],
    outletTotals: [],
    grandTotal: 0
  };

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
    isBackendAvailable: false,
    // item_code -> item_group ("VOUCHER"/"PETSHOP"/etc.), derived from sales
    // history. The stock CSV itself has no category column, so this is
    // fetched once separately and cross-referenced when filtering the table.
    itemGroupMap: {}
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
    setupStockoutControls();
    setupABCControls();
    setupOutletPerformanceControls();
    setupVendorAnalysisControls();
    setupTrendAnalysisControls();
    setupImportCenter();

    // Check backend API and database first, fallback to static CSV
    checkBackendAndLoad();
    loadItemGroupMap();
    loadSiteLabel();
  }

  // Bandung and Cimahi run the exact same code as two separate deployments
  // (see docker-compose.yml) — the only thing that tells them apart in the
  // UI is a SITE_NAME env var each instance sets, surfaced here so the
  // sidebar and browser tab make it obvious which one you're looking at.
  async function loadSiteLabel() {
    try {
      const res = await fetch('/api/config');
      const json = await res.json();
      if (json.success && json.siteName) {
        const brandTitle = document.getElementById('brand-title');
        if (brandTitle) brandTitle.textContent = json.siteName.toUpperCase();
        document.title = `Voucher Analytics - ${json.siteName}`;
      }
    } catch (e) {
      console.warn('Gagal memuat label wilayah:', e.message);
    }
  }

  // Fetches the item_code -> item_group (category) map derived from sales
  // history, used to filter/label the Matriks Stok Cabang table by category
  // even though the stock CSV itself carries no category column.
  async function loadItemGroupMap() {
    try {
      const res = await fetch('/api/analytics/item-groups');
      const json = await res.json();
      if (json.success) {
        appState.itemGroupMap = json.itemGroupMap || {};
        populateCategoryFilter('stock-category-filter', json.availableItemGroups || []);
      }
    } catch (e) {
      console.warn('Gagal memuat pemetaan kategori item (mode lokal/offline?)', e);
    }
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

  // ============================================================
  // LAZY-LOAD HEAVY LIBRARIES
  // SheetJS (xlsx) is ~900KB — instead of a blocking <script> tag paid by
  // every visit, it's only fetched the first time a user actually clicks an
  // "Ekspor .../XLSX" button. Subsequent clicks reuse the already-loaded lib.
  // ============================================================
  const _scriptPromises = {};
  function loadScriptOnce(url) {
    if (!_scriptPromises[url]) {
      _scriptPromises[url] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.async = true;
        s.onload = resolve;
        s.onerror = () => { delete _scriptPromises[url]; reject(new Error('Gagal memuat skrip: ' + url)); };
        document.head.appendChild(s);
      });
    }
    return _scriptPromises[url];
  }

  const XLSX_CDN_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  async function ensureXLSX() {
    if (typeof XLSX === 'undefined') {
      await loadScriptOnce(XLSX_CDN_URL);
    }
  }

  // Shared by every tab's "Kategori" filter (Item Group: VOUCHER/PETSHOP/ACC
  // CAMPURAN/etc.) — populates a <select> from the backend's availableItemGroups
  // list, preserving whatever the user already had selected.
  function populateCategoryFilter(selectId, availableItemGroups) {
    const filter = document.getElementById(selectId);
    if (!filter) return;
    const currentVal = filter.value;
    const groups = availableItemGroups || [];

    filter.innerHTML = '<option value="ALL">-- Semua Kategori --</option>';
    groups.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g;
      filter.appendChild(opt);
    });
    if (groups.includes(currentVal)) filter.value = currentVal;
  }

  // ============================================================
  // GENERIC COLUMN SORT (click a table header to sort by that column)
  // Shared by every analytics table: each render*Table() function sorts its
  // filtered array with applyColumnSort() right before building row HTML,
  // and each setup*Controls() wires the header clicks once with
  // initSortableTable() (headers are static HTML, so this only runs once
  // per tab — except the virtualized main stock table, whose headers are
  // rebuilt on every render, so it re-wires itself each time instead).
  // ============================================================
  function applyColumnSort(rows, tableBodyId, accessor) {
    const state = columnSortState[tableBodyId];
    if (!state || !state.key) return rows;
    const dir = state.dir === 'desc' ? -1 : 1;
    const getValue = accessor || ((row, key) => row[key]);
    return [...rows].sort((a, b) => {
      let va = getValue(a, state.key);
      let vb = getValue(b, state.key);
      if (va === null || va === undefined) va = typeof vb === 'number' ? -Infinity : '';
      if (vb === null || vb === undefined) vb = typeof va === 'number' ? -Infinity : '';
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  }

  function initSortableTable(tableBodyId, onSortChange) {
    const tbody = document.getElementById(tableBodyId);
    const table = tbody ? tbody.closest('table') : null;
    const headers = table ? Array.from(table.querySelectorAll('thead th[data-sort-key]')) : [];
    if (headers.length === 0) return;

    if (!columnSortState[tableBodyId]) columnSortState[tableBodyId] = { key: null, dir: 'asc' };
    const state = columnSortState[tableBodyId];

    headers.forEach(th => {
      th.classList.add('sortable-col');
      th.classList.remove('sort-asc', 'sort-desc');
      if (state.key === th.dataset.sortKey) th.classList.add(state.dir === 'asc' ? 'sort-asc' : 'sort-desc');

      th.addEventListener('click', () => {
        const key = th.dataset.sortKey;
        if (state.key === key) {
          state.dir = state.dir === 'asc' ? 'desc' : 'asc';
        } else {
          state.key = key;
          state.dir = 'asc';
        }
        headers.forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
        th.classList.add(state.dir === 'asc' ? 'sort-asc' : 'sort-desc');
        onSortChange();
      });
    });
  }

  // ============================================================
  // GENERIC VIRTUAL SCROLL for large non-virtualized analytics tables
  // (Ketahanan Stok, Riwayat Stockout, ABC & Aging can each reach 1000+
  // filtered rows). Same windowed-render technique as the main stock matrix
  // (see VT_ROW_HEIGHT/renderVisibleRows above), generalized to any table
  // whose rows share one fixed height, so only ~20-40 <tr> ever exist in the
  // DOM regardless of how many rows are filtered in.
  // ============================================================
  const ANALYTICS_VT_ROW_HEIGHT = 56; // tallest row here (Ketahanan Stok, up to 2 badge lines) plus padding
  const analyticsVirtualItems = {}; // tableBodyId -> current filtered+sorted array

  function renderVirtualRows(tableBodyId, colCount, rowHtmlFn, resetScroll) {
    const tbody = document.getElementById(tableBodyId);
    const wrapper = tbody ? (tbody.closest('.data-table-container') || tbody.closest('.table-wrapper')) : null;
    if (!tbody || !wrapper) return;

    const items = analyticsVirtualItems[tableBodyId] || [];
    if (resetScroll) wrapper.scrollTop = 0;

    const table = tbody.closest('table');
    const thead = table ? table.querySelector('thead') : null;
    const theadHeight = thead ? thead.offsetHeight : 0;
    const scrollTop = Math.max(0, wrapper.scrollTop - theadHeight);
    const viewportHeight = wrapper.clientHeight || 600;

    const total = items.length;
    const startIndex = Math.max(0, Math.floor(scrollTop / ANALYTICS_VT_ROW_HEIGHT) - VT_BUFFER_ROWS);
    const visibleCount = Math.ceil(viewportHeight / ANALYTICS_VT_ROW_HEIGHT) + VT_BUFFER_ROWS * 2;
    const endIndex = Math.min(total, startIndex + visibleCount);

    const topSpacer = startIndex * ANALYTICS_VT_ROW_HEIGHT;
    const bottomSpacer = Math.max(0, (total - endIndex) * ANALYTICS_VT_ROW_HEIGHT);

    let html = '';
    if (topSpacer > 0) html += `<tr class="v-spacer-row"><td colspan="${colCount}" style="height:${topSpacer}px; padding:0; border:none; background:transparent;"></td></tr>`;
    for (let i = startIndex; i < endIndex; i++) html += rowHtmlFn(items[i], i);
    if (bottomSpacer > 0) html += `<tr class="v-spacer-row"><td colspan="${colCount}" style="height:${bottomSpacer}px; padding:0; border:none; background:transparent;"></td></tr>`;

    tbody.innerHTML = html;
    if (window.lucide) lucide.createIcons();
  }

  // Stores the current filtered+sorted array for a table and (re)renders its
  // visible window. Call this from render*Table() every time filters/sort
  // change instead of building the full rowsHtml string.
  function setVirtualItemsAndRender(tableBodyId, items, colCount, rowHtmlFn) {
    analyticsVirtualItems[tableBodyId] = items;
    renderVirtualRows(tableBodyId, colCount, rowHtmlFn, true);
  }

  // Wires the scroll listener once (call from setup*Controls()); the thead
  // is static HTML so, unlike the main table, this never needs re-wiring.
  function setupVirtualScroll(tableBodyId, colCount, rowHtmlFn) {
    const tbody = document.getElementById(tableBodyId);
    const wrapper = tbody ? (tbody.closest('.data-table-container') || tbody.closest('.table-wrapper')) : null;
    if (!wrapper || wrapper._analyticsVtHandler) return;

    let ticking = false;
    const handler = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        renderVirtualRows(tableBodyId, colCount, rowHtmlFn, false);
        ticking = false;
      });
    };
    wrapper._analyticsVtHandler = handler;
    wrapper.addEventListener('scroll', handler, { passive: true });
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
      applyTableAndChartFilters();
    });

    const categoryFilter = document.getElementById('stock-category-filter');
    if (categoryFilter) {
      categoryFilter.addEventListener('change', applyTableAndChartFilters);
    }
  }

  // Re-renders both the table (via filterTableRows) and the two charts above
  // it so Kategori/search stay in sync everywhere — previously only the
  // table respected these filters while the charts kept showing the whole
  // active merk's data regardless of category or search text.
  function applyTableAndChartFilters() {
    filterTableRows();
    const merkData = getActiveMerkData();
    if (!merkData) return;
    const outlets = OutletSorter.sortOutlets(merkData.outlets, appState.activeMerk);
    renderCharts(getFilteredMerkDataForCharts(merkData), outlets);
  }

  // Applies the same Kategori + search matching that filterTableRows() uses
  // for the table, but to a merkData-shaped object so renderCharts() (which
  // reads merkData.items directly) shows a consistent picture.
  function getFilteredMerkDataForCharts(merkData) {
    const q = appState.searchQuery;
    const categoryFilter = document.getElementById('stock-category-filter')?.value || 'ALL';
    if (categoryFilter === 'ALL' && !q) return merkData;

    const items = {};
    Object.entries(merkData.items).forEach(([code, item]) => {
      if (categoryFilter !== 'ALL' && (appState.itemGroupMap[code] || 'LAINNYA') !== categoryFilter) return;
      if (q && !code.toLowerCase().includes(q) && !item.name.toLowerCase().includes(q)) return;
      items[code] = item;
    });
    return { ...merkData, items };
  }

  function onMerkChanged() {
    if (!appState.activeMerk) {
      clearUI();
      return;
    }
    renderTableAndCharts();
  }

  // Resolves the currently active merk's item/outlet data (merged across all
  // merks when "ALL" is selected). Shared by renderTable() and renderCharts()
  // so the merge + outlet sort only run once per render instead of twice.
  function getActiveMerkData() {
    if (!appState.parsedData) return null; // merk-selector can fire (e.g. browser form-state restore on reload) before initial data has loaded
    if (appState.activeMerk === 'ALL') {
      const merkData = {
        name: 'SEMUA MERK',
        items: {},
        outlets: appState.parsedData.allOutlets
      };
      Object.values(appState.parsedData.merks).forEach(merkObj => {
        Object.assign(merkData.items, merkObj.items);
      });
      return merkData;
    }
    return appState.parsedData.merks[appState.activeMerk];
  }

  function renderTableAndCharts() {
    const merkData = getActiveMerkData();
    if (!merkData) return;
    const outlets = OutletSorter.sortOutlets(merkData.outlets, appState.activeMerk);
    renderTable(merkData, outlets);
    renderCharts(getFilteredMerkDataForCharts(merkData), outlets);
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
    virtualTable = { items: [], filteredItems: [], outlets: [], outletTotals: [], grandTotal: 0 };
  }

  // 7. Render Stock Table with columns = Outlets, rows = Items
  // Only the rows currently scrolled into view are ever put in the DOM (see
  // renderVisibleRows below) — with "Semua Merk" selected there can be
  // ~1450 items x 43 outlets (~60k cells), which is what made opening data feel
  // laggy when the whole table was built and inserted into the DOM at once.
  function renderTable(merkData, outlets) {
    if (!merkData) {
      merkData = getActiveMerkData();
      if (!merkData) return;
    }
    if (!outlets) {
      outlets = OutletSorter.sortOutlets(merkData.outlets, appState.activeMerk);
    }

    const items = Object.values(merkData.items);

    // Render Table Headers (Columns = Outlets)
    // "Barang / Item" and "TOTAL (PCS)" are click-to-sort (data-sort-key); the
    // per-outlet columns stay drag-only (see OutletSorter below) since a click
    // handler on the same cell used for drag-and-drop would fight the drag
    // gesture.
    let headerHtml = `<th class="non-draggable sortable-col" data-sort-key="name">Barang / Item</th>`;

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
    headerHtml += `<th class="non-draggable sortable-col" style="text-align: center;" data-sort-key="total">TOTAL (PCS)</th>`;
    tableHeaders.innerHTML = headerHtml;
    initSortableTable('stock-table-body', filterTableRows);

    // Outlet/grand totals only need one numeric pass over the full item list
    // (cheap — no HTML string building) and stay fixed regardless of scroll
    // position or the active search filter, matching the previous behavior.
    const outletTotals = new Array(outlets.length).fill(0);
    let grandTotal = 0;
    items.forEach(item => {
      for (let o = 0; o < outlets.length; o++) {
        const stock = item.stocks[outlets[o]] || 0;
        outletTotals[o] += stock;
        grandTotal += stock;
      }
    });

    virtualTable.items = items;
    virtualTable.outlets = outlets;
    virtualTable.outletTotals = outletTotals;
    virtualTable.grandTotal = grandTotal;

    // Setup drag-and-drop on the header row <tr> element
    if (appState.sorterInstance) {
      appState.sorterInstance.destroy();
    }

    appState.sorterInstance = new OutletSorter(tableHeaders, appState.activeMerk, (newOrder) => {
      // Callback triggered when user finishes dragging columns
      console.log('Outlet order updated:', newOrder);
      // Rerender table so that body cells are correctly aligned with headers
      renderTableAndCharts();
    });

    filterTableRows(); // (re)computes the filtered item list and renders the visible window
    setupVirtualScrollListener();
  }

  // Builds one item row's HTML (extracted so renderVisibleRows can call it per visible item only)
  function buildItemRowHtml(item, outlets) {
    let itemTotal = 0;
    let cellsHtml = '';

    for (let o = 0; o < outlets.length; o++) {
      const stock = item.stocks[outlets[o]] || 0;
      itemTotal += stock;

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
    }

    const itemGroup = appState.itemGroupMap[item.code];

    return `
      <tr data-item-code="${escapeHtml(item.code)}" data-item-name="${escapeHtml(item.name.toLowerCase())}">
        <td>
          <div style="font-weight: 600; color: var(--text-primary); white-space: normal; min-width: 220px;">${escapeHtml(item.name)}</div>
          <div style="font-size: 11px; color: var(--text-muted);">${escapeHtml(item.code)}${itemGroup ? ` &bull; ${escapeHtml(itemGroup)}` : ''}</div>
        </td>
        ${cellsHtml}
        <td class="outlet-total" style="font-weight: 700; color: var(--accent-cyan); text-align: center;">${itemTotal}</td>
      </tr>
    `;
  }

  // Renders only the rows scrolled into view (plus a small buffer), using two
  // spacer <tr> elements to keep the scrollbar height and column widths correct.
  function renderVisibleRows(resetScroll) {
    const wrapper = tableBody.closest('.table-wrapper');
    if (!wrapper) return;

    if (resetScroll) wrapper.scrollTop = 0;

    const items = virtualTable.filteredItems;
    const outlets = virtualTable.outlets;
    const total = items.length;
    const colCount = outlets.length + 2;

    const thead = tableHeaders.closest('thead');
    const theadHeight = thead ? thead.offsetHeight : 0;
    const scrollTop = Math.max(0, wrapper.scrollTop - theadHeight);
    const viewportHeight = wrapper.clientHeight || 600;

    let startIndex = Math.max(0, Math.floor(scrollTop / VT_ROW_HEIGHT) - VT_BUFFER_ROWS);
    const visibleCount = Math.ceil(viewportHeight / VT_ROW_HEIGHT) + VT_BUFFER_ROWS * 2;
    const endIndex = Math.min(total, startIndex + visibleCount);

    const topSpacerHeight = startIndex * VT_ROW_HEIGHT;
    const bottomSpacerHeight = Math.max(0, (total - endIndex) * VT_ROW_HEIGHT);

    let tbodyHtml = '';
    if (topSpacerHeight > 0) {
      tbodyHtml += `<tr class="v-spacer-row"><td colspan="${colCount}" style="height:${topSpacerHeight}px; padding:0; border:none; background:transparent;"></td></tr>`;
    }

    for (let i = startIndex; i < endIndex; i++) {
      tbodyHtml += buildItemRowHtml(items[i], outlets);
    }

    if (bottomSpacerHeight > 0) {
      tbodyHtml += `<tr class="v-spacer-row"><td colspan="${colCount}" style="height:${bottomSpacerHeight}px; padding:0; border:none; background:transparent;"></td></tr>`;
    }

    // TOTAL summary row: always shown, computed once in renderTable() over the
    // full (unfiltered) item list — matches the previous non-virtualized behavior.
    let totalCellsHtml = '';
    virtualTable.outletTotals.forEach(outletTotal => {
      totalCellsHtml += `<td style="font-weight: 800; color: var(--accent-indigo); text-align: center;">${outletTotal}</td>`;
    });
    tbodyHtml += `
      <tr style="background: rgba(99, 102, 241, 0.05); border-top: 2px solid var(--panel-border);">
        <td>
          <div style="font-weight: 800; color: var(--text-primary); text-transform: uppercase;">TOTAL</div>
        </td>
        ${totalCellsHtml}
        <td style="font-weight: 800; color: var(--accent-cyan); text-align: center;">${virtualTable.grandTotal}</td>
      </tr>
    `;

    tableBody.innerHTML = tbodyHtml;
    lucide.createIcons();
  }

  // Attaches (once) the scroll listener that drives the windowed re-render above.
  function setupVirtualScrollListener() {
    const wrapper = tableBody.closest('.table-wrapper');
    if (!wrapper) return;

    if (wrapper._vtScrollHandler) {
      wrapper.removeEventListener('scroll', wrapper._vtScrollHandler);
    }

    let ticking = false;
    const handler = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        renderVisibleRows(false);
        ticking = false;
      });
    };
    wrapper._vtScrollHandler = handler;
    wrapper.addEventListener('scroll', handler, { passive: true });
  }

  // 8. Filter Table Rows based on Search
  // Filters the in-memory item list (rather than toggling DOM visibility, which
  // doesn't work once rows outside the viewport are no longer in the DOM) and
  // re-renders just the visible window against the filtered list.
  function filterTableRows() {
    const q = appState.searchQuery;
    const categoryFilter = document.getElementById('stock-category-filter')?.value || 'ALL';

    let filtered = virtualTable.items.filter(item => {
      if (categoryFilter !== 'ALL' && (appState.itemGroupMap[item.code] || 'LAINNYA') !== categoryFilter) return false;
      if (q && !item.code.toLowerCase().includes(q) && !item.name.toLowerCase().includes(q)) return false;
      return true;
    });

    filtered = applyColumnSort(filtered, 'stock-table-body', (item, key) => {
      if (key === 'total') {
        const outlets = virtualTable.outlets || [];
        let total = 0;
        for (let i = 0; i < outlets.length; i++) total += item.stocks[outlets[i]] || 0;
        return total;
      }
      return item[key];
    });

    virtualTable.filteredItems = filtered;
    renderVisibleRows(true);
  }

  // 9. Render Chart.js Visualizations
  function renderCharts(merkData, sortedOutlets) {
    if (!merkData) {
      merkData = getActiveMerkData();
      if (!merkData) return;
    }
    if (!sortedOutlets) {
      sortedOutlets = OutletSorter.sortOutlets(merkData.outlets, appState.activeMerk);
    }

    // Destory existing charts
    if (appState.itemChart) appState.itemChart.destroy();
    if (appState.outletChart) appState.outletChart.destroy();

    // Gather statistics
    const itemsData = StockAnalytics.getItemStatistics(merkData);

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
        renderTableAndCharts();
        showStatus('Urutan outlet berhasil dikembalikan ke default.', 'info');
      }
    });

    // Export Table Layout back to CSV format
    btnExportCsv.addEventListener('click', () => {
      if (!appState.parsedData || !appState.activeMerk) {
        alert('Tidak ada data yang dapat diekspor. Pilih merk terlebih dahulu.');
        return;
      }

      // Matches whatever's currently on screen — reuses the same Kategori +
      // search filtering as the table and charts, instead of re-deriving an
      // unfiltered item list from scratch (that previously made the export
      // always include every item regardless of active filters).
      const merkData = getFilteredMerkDataForCharts(getActiveMerkData());
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
    btnExportXlsx.addEventListener('click', async () => {
      if (!appState.parsedData || !appState.activeMerk) {
        alert('Tidak ada data yang dapat diekspor. Pilih merk terlebih dahulu.');
        return;
      }

      try {
        await ensureXLSX();
      } catch (e) {
        alert('Pustaka ekspor Excel gagal dimuat. Harap periksa koneksi internet Anda.');
        return;
      }

      const merkData = getFilteredMerkDataForCharts(getActiveMerkData());
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
      // Wrapper height just changed — re-render the visible window immediately
      // instead of waiting for the next scroll event.
      if (virtualTable.outlets.length > 0) {
        setTimeout(() => renderVisibleRows(false), 0);
      }
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
        const merkData = getActiveMerkData();
        if (merkData) renderCharts(getFilteredMerkDataForCharts(merkData));
      }
    }
  }

  // 12. Setup Database Management Page (Tab: Kelola Database)
  function setupDatabaseModal() {
    const btnClearDb = document.getElementById('btn-clear-db');
    const restoreFileInput = document.getElementById('restore-file-input');

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
            loadDatabaseInfo();
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
            loadDatabaseInfo();
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

  // Loads stats + report history for the "Kelola Database" tab (lazy-loaded on tab click)
  async function loadDatabaseInfo() {
    const dbStatSize = document.getElementById('db-stat-size');
    const dbStatReports = document.getElementById('db-stat-reports');
    const dbStatRecords = document.getElementById('db-stat-records');
    const dbStatRange = document.getElementById('db-stat-range');
    const dbStatAutoBackup = document.getElementById('db-stat-autobackup');
    const dbReportsList = document.getElementById('db-reports-list');
    if (!dbReportsList) return;

    if (!appState.isBackendAvailable) {
      dbReportsList.innerHTML = '<div style="text-align: center; padding: 30px 10px; color: var(--text-muted); font-style: italic;">Fitur manajemen database hanya aktif saat server backend berjalan (port 3000). Silakan jalankan "npm start" atau deploy di ZimaOS.</div>';
      return;
    }

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
            ? `${formatDateDisplay(json.info.stockRange.first)} s/d ${formatDateDisplay(json.info.stockRange.latest)}`
            : '-';
          if (dbStatAutoBackup) {
            const ab = json.info.autoBackup;
            dbStatAutoBackup.textContent = ab && ab.count > 0
              ? `${ab.count}x · ${new Date(ab.latestAt).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })}`
              : 'Belum ada';
          }
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

            card.innerHTML = `
              <div class="report-item-header">
                <div class="report-item-date">
                  <i data-lucide="calendar" style="width: 14px; height: 14px;"></i> ${escapeHtml(dateDisplay)}
                </div>
                <span class="badge-stock">${totalStockFmt}</span>
              </div>
              <div class="report-item-meta">
                <span>${escapeHtml(d.filename || 'Laporan')}</span> &bull; <span>${d.total_merks || 0} merk / ${d.total_items || 0} item</span>
              </div>
              <div class="report-item-actions">
                <button class="btn-mini-primary" data-action="view" data-date="${escapeHtml(d.report_date)}">
                  <i data-lucide="eye" style="width: 13px; height: 13px;"></i> Buka di Tabel
                </button>
                <button class="btn-mini-danger" data-action="delete" data-date="${escapeHtml(d.report_date)}">
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
              const stockTabBtn = document.querySelector('.tab-btn[data-tab="stock-matrix"]');
              if (stockTabBtn) stockTabBtn.click();
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
                    loadDatabaseInfo();
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
      'po-planner': 'Rencana Belanja (PO)',
      'stockout-history': 'Riwayat Stockout',
      'abc-aging': 'ABC & Aging Stok',
      'outlet-performance': 'Performa Cabang',
      'vendor-analysis': 'Supplier / Vendor',
      'trend-analysis': 'Tren Periode',
      'database': 'Kelola Database',
      'import': 'Import Database'
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
        } else if (targetTab === 'stockout-history') {
          loadStockoutHistoryData();
        } else if (targetTab === 'abc-aging') {
          loadABCAgingData();
        } else if (targetTab === 'outlet-performance') {
          loadOutletPerformanceData();
        } else if (targetTab === 'vendor-analysis') {
          loadVendorAnalysisData();
        } else if (targetTab === 'trend-analysis') {
          loadTrendAnalysisData();
        } else if (targetTab === 'database') {
          loadDatabaseInfo();
        } else if (targetTab === 'import') {
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
  // TAB 2: SMART REBALANCING (TRANSFER ANTAR-CABANG)
  // ============================================================
  let rebalanceRecommendations = [];

  async function loadRebalanceData() {
    const tableBody = document.getElementById('rebalance-table-body');
    if (!tableBody) return;

    try {
      tableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 40px; color: var(--text-muted);"><i data-lucide="loader-2" class="spin"></i> Memuat rekomendasi transfer antar-cabang...</td></tr>`;
      if (window.lucide) lucide.createIcons();

      const days = document.getElementById('rebalance-days-filter')?.value || '1';
      const url = `/api/analytics/rebalancing?stockDate=${encodeURIComponent(appState.currentDate || '')}&days=${encodeURIComponent(days)}`;
      const res = await fetch(url);
      const json = await res.json();

      if (!json.success || !Array.isArray(json.recommendations)) {
        throw new Error(json.message || 'Gagal mengambil data rekomendasi');
      }

      rebalanceRecommendations = json.recommendations;

      // Update badge in tab button
      const badge = document.getElementById('badge-transfer-count');
      if (badge) badge.textContent = json.count || 0;

      // Populate merk & category filters
      populateRebalanceMerkFilter(rebalanceRecommendations);
      populateCategoryFilter('rebalance-category-filter', json.availableItemGroups);

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
    const categoryFilter = document.getElementById('rebalance-category-filter')?.value || 'ALL';
    const query = (document.getElementById('rebalance-search-input')?.value || '').toLowerCase().trim();

    let filtered = rebalanceRecommendations.filter(r => {
      if (urgencyFilter !== 'ALL' && r.urgency !== urgencyFilter) return false;
      if (merkFilter !== 'ALL' && r.merk !== merkFilter) return false;
      if (categoryFilter !== 'ALL' && r.itemGroup !== categoryFilter) return false;
      if (query) {
        const matchItem = (r.itemName || '').toLowerCase().includes(query) || (r.itemCode || '').includes(query);
        const matchFrom = (r.fromOutlet || '').toLowerCase().includes(query);
        const matchTo = (r.toOutlet || '').toLowerCase().includes(query);
        if (!matchItem && !matchFrom && !matchTo) return false;
      }
      return true;
    });

    filtered = applyColumnSort(filtered, 'rebalance-table-body');

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
          <td>
            <div style="font-size: 11.5px; color: var(--accent-cyan);">${escapeHtml(r.merk || '-')}</div>
            <div style="font-size: 10px; color: var(--text-muted);">${escapeHtml(r.itemGroup || '-')}</div>
          </td>
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
    const daysFilter = document.getElementById('rebalance-days-filter');
    const urgencyFilter = document.getElementById('rebalance-urgency-filter');
    const merkFilter = document.getElementById('rebalance-merk-filter');
    const searchInput = document.getElementById('rebalance-search-input');
    const btnExport = document.getElementById('btn-export-rebalance');

    const categoryFilter = document.getElementById('rebalance-category-filter');

    initSortableTable('rebalance-table-body', renderRebalanceTable);

    if (daysFilter) daysFilter.addEventListener('change', loadRebalanceData);
    if (urgencyFilter) urgencyFilter.addEventListener('change', renderRebalanceTable);
    if (merkFilter) merkFilter.addEventListener('change', renderRebalanceTable);
    if (categoryFilter) categoryFilter.addEventListener('change', renderRebalanceTable);
    if (searchInput) searchInput.addEventListener('input', renderRebalanceTable);

    if (btnExport) {
      btnExport.addEventListener('click', async () => {
        if (!rebalanceRecommendations || rebalanceRecommendations.length === 0) {
          alert('Tidak ada data rekomendasi transfer untuk diekspor.');
          return;
        }
        try { await ensureXLSX(); } catch (e) { alert('Pustaka ekspor Excel gagal dimuat. Periksa koneksi internet Anda.'); return; }

        const dataToExport = rebalanceRecommendations.map((r, i) => ({
          'No': i + 1,
          'Kode Item': r.itemCode,
          'Nama Barang': r.itemName,
          'Merk': r.merk,
          'Kategori': r.itemGroup,
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

      const days = document.getElementById('coverage-days-filter')?.value || '1';
      const url = `/api/analytics/integrated?stockDate=${encodeURIComponent(appState.currentDate || '')}&days=${encodeURIComponent(days)}`;
      const res = await fetch(url);
      const json = await res.json();

      if (!json.success || !json.data) throw new Error(json.message || 'Gagal mengambil data ketahanan');
      coverageData = json.data;
      populateCategoryFilter('coverage-category-filter', coverageData.availableItemGroups);
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
    const categoryFilter = document.getElementById('coverage-category-filter')?.value || 'ALL';
    const query = (document.getElementById('coverage-search-input')?.value || '').toLowerCase().trim();

    let items = Object.values(coverageData.items).filter(item => {
      if (query && !item.name.toLowerCase().includes(query) && !item.code.includes(query)) return false;
      if (categoryFilter !== 'ALL' && item.itemGroup !== categoryFilter) return false;

      if (statusFilter !== 'ALL') {
        const hasMatchingOutlet = Object.values(item.outlets).some(o => o.status === statusFilter);
        if (!hasMatchingOutlet) return false;
      }
      return true;
    });

    items = applyColumnSort(items, 'coverage-table-body');

    if (items.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 40px; color: var(--text-muted);">Tidak ada data barang yang sesuai filter ketahanan.</td></tr>`;
      return;
    }

    setVirtualItemsAndRender('coverage-table-body', items, 8, buildCoverageRowHtml);
  }

  // Extracted from renderCoverageTable so the virtual scroller can call it
  // per-visible-row instead of building HTML for the entire filtered list.
  function buildCoverageRowHtml(item, idx) {
    const criticalOutlets = [];
    const overstockOutlets = [];

    Object.entries(item.outlets).forEach(([outlet, out]) => {
      if (out.status === 'OUT_OF_STOCK') {
        criticalOutlets.push(`<span class="status-badge badge-critical">${escapeHtml(outlet)}: KOSONG (${out.ads}/hr)</span>`);
      } else if (out.status === 'CRITICAL') {
        criticalOutlets.push(`<span class="status-badge badge-critical">${escapeHtml(outlet)}: ${out.doc} hr</span>`);
      } else if (out.status === 'OVERSTOCK') {
        overstockOutlets.push(`<span class="status-badge badge-overstock">${escapeHtml(outlet)}: ${out.doc} hr (${out.stock} pcs)</span>`);
      }
    });

    // white-space:nowrap + ellipsis keeps each line from wrapping onto a
    // second visual line, which matters here since the virtual scroller
    // assumes a fixed row height (ANALYTICS_VT_ROW_HEIGHT).
    const lineStyle = 'white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
    let outletDetails = '';
    if (criticalOutlets.length > 0) {
      outletDetails += `<div style="margin-bottom: 4px; ${lineStyle}"><strong>Kritis:</strong> ${criticalOutlets.slice(0, 4).join(' ')} ${criticalOutlets.length > 4 ? `+${criticalOutlets.length - 4}` : ''}</div>`;
    }
    if (overstockOutlets.length > 0) {
      outletDetails += `<div style="${lineStyle}"><strong>Overstock:</strong> ${overstockOutlets.slice(0, 4).join(' ')} ${overstockOutlets.length > 4 ? `+${overstockOutlets.length - 4}` : ''}</div>`;
    }
    if (!outletDetails) outletDetails = '<span style="color: var(--text-muted); font-size: 11px;">Kondisi Normal / Seimbang</span>';

    const docDisplay = item.globalDoC >= 999 ? '∞' : `${item.globalDoC} hr`;

    return `
      <tr>
        <td style="text-align: center; color: var(--text-muted);">${idx + 1}</td>
        <td style="font-family: monospace; font-size: 12px;">${escapeHtml(item.code)}</td>
        <td style="font-weight: 700;">${escapeHtml(item.name)}</td>
        <td>
          <div style="font-size: 11.5px; color: var(--accent-cyan);">${escapeHtml(item.merk || '-')}</div>
          <div style="font-size: 10px; color: var(--text-muted);">${escapeHtml(item.itemGroup || '-')}</div>
        </td>
        <td style="text-align: right; font-weight: 700;">${item.totalStock.toLocaleString('id-ID')}</td>
        <td style="text-align: right; color: var(--status-warning); font-weight: 700;">${item.totalADS}</td>
        <td style="text-align: right; font-weight: 800; color: ${item.globalDoC < 3 ? 'var(--status-danger)' : 'var(--status-success)'};">${docDisplay}</td>
        <td style="font-size: 11.5px;">${outletDetails}</td>
      </tr>
    `;
  }

  function setupCoverageControls() {
    const daysFilter = document.getElementById('coverage-days-filter');
    const statusFilter = document.getElementById('coverage-status-filter');
    const searchInput = document.getElementById('coverage-search-input');
    const btnExport = document.getElementById('btn-export-coverage');

    const categoryFilter = document.getElementById('coverage-category-filter');

    initSortableTable('coverage-table-body', renderCoverageTable);
    setupVirtualScroll('coverage-table-body', 8, buildCoverageRowHtml);

    if (daysFilter) daysFilter.addEventListener('change', loadCoverageData);
    if (statusFilter) statusFilter.addEventListener('change', renderCoverageTable);
    if (categoryFilter) categoryFilter.addEventListener('change', renderCoverageTable);
    if (searchInput) searchInput.addEventListener('input', renderCoverageTable);

    if (btnExport) {
      btnExport.addEventListener('click', async () => {
        if (!coverageData || !coverageData.items) {
          alert('Tidak ada data ketahanan stok untuk diekspor.');
          return;
        }
        try { await ensureXLSX(); } catch (e) { alert('Pustaka ekspor Excel gagal dimuat. Periksa koneksi internet Anda.'); return; }

        const dataToExport = Object.values(coverageData.items).map((item, i) => ({
          'No': i + 1,
          'Kode Item': item.code,
          'Nama Barang': item.name,
          'Merk': item.merk,
          'Kategori': item.itemGroup,
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

      const days = document.getElementById('po-days-filter')?.value || '1';
      const url = `/api/analytics/po?stockDate=${encodeURIComponent(appState.currentDate || '')}&days=${encodeURIComponent(days)}`;
      const res = await fetch(url);
      const json = await res.json();

      if (!json.success || !Array.isArray(json.suggestions)) throw new Error(json.message || 'Gagal memuat PO');

      poSuggestions = json.suggestions;

      const badge = document.getElementById('badge-po-count');
      if (badge) badge.textContent = json.count || 0;

      populatePOMerkFilter(poSuggestions);
      populateCategoryFilter('po-category-filter', json.availableItemGroups);
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
    const categoryFilter = document.getElementById('po-category-filter')?.value || 'ALL';
    const query = (document.getElementById('po-search-input')?.value || '').toLowerCase().trim();

    let filtered = poSuggestions.filter(s => {
      if (merkFilter !== 'ALL' && s.merk !== merkFilter) return false;
      if (categoryFilter !== 'ALL' && s.itemGroup !== categoryFilter) return false;
      if (query && !s.itemName.toLowerCase().includes(query) && !s.itemCode.includes(query)) return false;
      return true;
    });

    filtered = applyColumnSort(filtered, 'po-table-body');

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
          <td style="font-family: monospace; font-size: 12px;">${escapeHtml(s.itemCode)}</td>
          <td style="font-weight: 700;">${escapeHtml(s.itemName)}</td>
          <td>
            <div style="font-size: 11.5px; color: var(--accent-cyan);">${escapeHtml(s.merk || '-')}</div>
            <div style="font-size: 10px; color: var(--text-muted);">${escapeHtml(s.itemGroup || '-')}</div>
          </td>
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
    const daysFilter = document.getElementById('po-days-filter');
    const merkFilter = document.getElementById('po-merk-filter');
    const searchInput = document.getElementById('po-search-input');
    const btnExport = document.getElementById('btn-export-po');

    const categoryFilter = document.getElementById('po-category-filter');

    initSortableTable('po-table-body', renderPOTable);

    if (daysFilter) daysFilter.addEventListener('change', loadPOData);

    if (merkFilter) merkFilter.addEventListener('change', renderPOTable);
    if (categoryFilter) categoryFilter.addEventListener('change', renderPOTable);
    if (searchInput) searchInput.addEventListener('input', renderPOTable);

    if (btnExport) {
      btnExport.addEventListener('click', async () => {
        if (!poSuggestions || poSuggestions.length === 0) {
          alert('Tidak ada saran PO untuk diekspor.');
          return;
        }
        try { await ensureXLSX(); } catch (e) { alert('Pustaka ekspor Excel gagal dimuat. Periksa koneksi internet Anda.'); return; }

        const dataToExport = poSuggestions.map((s, i) => ({
          'No': i + 1,
          'Kode Item': s.itemCode,
          'Nama Barang': s.itemName,
          'Merk': s.merk,
          'Kategori': s.itemGroup,
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
  // TAB 5: RIWAYAT STOCKOUT (POLA KEBIASAAN & BARANG KRONIS)
  // Tracks, across the daily stock reports uploaded over time, which items
  // are both fast-moving (high ADS) AND frequently out of stock — the
  // "sering laku tapi sering kosong" chronic problem items.
  // ============================================================
  let stockoutData = null;

  async function loadStockoutHistoryData() {
    const tableBody = document.getElementById('stockout-table-body');
    if (!tableBody) return;

    try {
      tableBody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 40px; color: var(--text-muted);"><i data-lucide="loader-2" class="spin"></i> Memuat riwayat stockout...</td></tr>`;
      if (window.lucide) lucide.createIcons();

      const days = document.getElementById('stockout-days-filter')?.value || 30;
      const res = await fetch(`/api/analytics/stockout-history?days=${encodeURIComponent(days)}`);
      const json = await res.json();

      if (!json.success || !json.data) throw new Error(json.message || 'Gagal mengambil data riwayat stockout');

      stockoutData = json.data;
      populateStockoutMerkFilter(stockoutData.items);
      populateCategoryFilter('stockout-category-filter', stockoutData.availableItemGroups);
      renderStockoutTable();
    } catch (err) {
      console.error('Stockout history load error:', err);
      tableBody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 40px; color: var(--status-danger);">Gagal memuat riwayat stockout: ${err.message}</td></tr>`;
    }
  }

  function populateStockoutMerkFilter(items) {
    const filter = document.getElementById('stockout-merk-filter');
    if (!filter) return;
    const currentVal = filter.value;
    const merks = new Set(items.map(i => i.merk).filter(Boolean));

    filter.innerHTML = '<option value="ALL">-- Semua Merk --</option>';
    Array.from(merks).sort().forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      filter.appendChild(opt);
    });
    if (merks.has(currentVal)) filter.value = currentVal;
  }

  function classifyStockoutStatus(item) {
    if (item.isChronic) return 'CHRONIC';
    if (item.avgStockoutRate >= 10) return 'WATCH';
    return 'SAFE';
  }

  function renderStockoutTable() {
    const tableBody = document.getElementById('stockout-table-body');
    if (!tableBody || !stockoutData || !stockoutData.items) return;

    const items = stockoutData.items;

    // KPI summary always reflects the full (unfiltered) dataset for the selected period
    const chronicCount = items.filter(i => i.isChronic).length;
    const avgRate = items.length > 0
      ? +(items.reduce((s, i) => s + i.avgStockoutRate, 0) / items.length).toFixed(1)
      : 0;
    const worstOutletEntry = stockoutData.outletSummary && stockoutData.outletSummary[0];

    const statItems = document.getElementById('stat-stockout-items');
    const statChronic = document.getElementById('stat-stockout-chronic');
    const statAvgRate = document.getElementById('stat-stockout-avgrate');
    const statWorstOutlet = document.getElementById('stat-stockout-worstoutlet');
    const badge = document.getElementById('badge-stockout-count');

    if (statItems) statItems.textContent = items.length.toLocaleString('id-ID');
    if (statChronic) statChronic.textContent = chronicCount.toLocaleString('id-ID');
    if (statAvgRate) statAvgRate.textContent = `${avgRate}%`;
    if (statWorstOutlet) statWorstOutlet.textContent = worstOutletEntry ? `${worstOutletEntry.outlet} (${worstOutletEntry.totalStockoutDays} hr)` : '-';
    if (badge) badge.textContent = chronicCount;

    const statusFilter = document.getElementById('stockout-status-filter')?.value || 'ALL';
    const merkFilter = document.getElementById('stockout-merk-filter')?.value || 'ALL';
    const categoryFilter = document.getElementById('stockout-category-filter')?.value || 'ALL';
    const query = (document.getElementById('stockout-search-input')?.value || '').toLowerCase().trim();

    let filtered = items.filter(item => {
      if (statusFilter !== 'ALL' && classifyStockoutStatus(item) !== statusFilter) return false;
      if (merkFilter !== 'ALL' && item.merk !== merkFilter) return false;
      if (categoryFilter !== 'ALL' && item.itemGroup !== categoryFilter) return false;
      if (query && !item.name.toLowerCase().includes(query) && !item.code.toLowerCase().includes(query)) return false;
      return true;
    });

    filtered = applyColumnSort(filtered, 'stockout-table-body');

    if (filtered.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 40px; color: var(--text-muted);">Tidak ada data yang sesuai filter riwayat stockout.</td></tr>`;
      return;
    }

    setVirtualItemsAndRender('stockout-table-body', filtered, 10, buildStockoutRowHtml);
  }

  // Extracted from renderStockoutTable so the virtual scroller can call it
  // per-visible-row instead of building HTML for the entire filtered list.
  function buildStockoutRowHtml(item, idx) {
    const status = classifyStockoutStatus(item);
    const statusBadge = status === 'CHRONIC'
      ? `<span class="status-badge badge-high-urgency">🔴 KRONIS</span>`
      : status === 'WATCH'
        ? `<span class="status-badge badge-med-urgency">🟡 WASPADA</span>`
        : `<span class="status-badge" style="background: rgba(16, 185, 129, 0.12); color: var(--status-success);">🟢 AMAN</span>`;

    const rateColor = item.avgStockoutRate >= 20 ? 'var(--status-danger)' : (item.avgStockoutRate >= 10 ? 'var(--status-warning)' : 'var(--status-success)');

    const problemOutlets = item.outletDetails.filter(o => o.daysOutOfStock > 0);
    let outletBadges = problemOutlets.slice(0, 4)
      .map(o => `<span class="status-badge badge-critical">${escapeHtml(o.outlet)}: ${o.daysOutOfStock} hr</span>`)
      .join(' ');
    if (problemOutlets.length > 4) outletBadges += ` <span style="color: var(--text-muted); font-size: 11px;">+${problemOutlets.length - 4}</span>`;
    if (!outletBadges) outletBadges = '<span style="color: var(--text-muted); font-size: 11px;">Tidak pernah kosong</span>';

    return `
      <tr>
        <td style="text-align: center; color: var(--text-muted);">${idx + 1}</td>
        <td style="font-family: monospace; font-size: 12px;">${escapeHtml(item.code)}</td>
        <td style="font-weight: 700;">${escapeHtml(item.name)}</td>
        <td>
          <div style="font-size: 11.5px; color: var(--accent-cyan);">${escapeHtml(item.merk || '-')}</div>
          <div style="font-size: 10px; color: var(--text-muted);">${escapeHtml(item.itemGroup || '-')}</div>
        </td>
        <td style="text-align: right; font-weight: 700;">${item.totalSold.toLocaleString('id-ID')}</td>
        <td style="text-align: right; color: var(--status-warning); font-weight: 700;">${item.ads}</td>
        <td style="text-align: right; font-weight: 800; color: ${rateColor};">${item.avgStockoutRate}%</td>
        <td style="font-size: 11.5px;">${escapeHtml(item.worstOutlet)}${item.maxDaysOutOfStock > 0 ? ` (${item.maxDaysOutOfStock} hr)` : ''}</td>
        <td style="text-align: center;">${statusBadge}</td>
        <td style="font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${outletBadges}</td>
      </tr>
    `;
  }

  function setupStockoutControls() {
    const daysFilter = document.getElementById('stockout-days-filter');
    const statusFilter = document.getElementById('stockout-status-filter');
    const merkFilter = document.getElementById('stockout-merk-filter');
    const searchInput = document.getElementById('stockout-search-input');
    const btnExport = document.getElementById('btn-export-stockout');

    initSortableTable('stockout-table-body', renderStockoutTable);
    setupVirtualScroll('stockout-table-body', 10, buildStockoutRowHtml);

    if (daysFilter) daysFilter.addEventListener('change', loadStockoutHistoryData);
    const categoryFilter = document.getElementById('stockout-category-filter');

    if (statusFilter) statusFilter.addEventListener('change', renderStockoutTable);
    if (merkFilter) merkFilter.addEventListener('change', renderStockoutTable);
    if (categoryFilter) categoryFilter.addEventListener('change', renderStockoutTable);
    if (searchInput) searchInput.addEventListener('input', renderStockoutTable);

    if (btnExport) {
      btnExport.addEventListener('click', async () => {
        if (!stockoutData || !stockoutData.items || stockoutData.items.length === 0) {
          alert('Tidak ada data riwayat stockout untuk diekspor.');
          return;
        }
        try { await ensureXLSX(); } catch (e) { alert('Pustaka ekspor Excel gagal dimuat. Periksa koneksi internet Anda.'); return; }

        const dataToExport = stockoutData.items.map((item, i) => ({
          'No': i + 1,
          'Kode Item': item.code,
          'Nama Barang': item.name,
          'Merk': item.merk,
          'Kategori': item.itemGroup,
          'Total Terjual': item.totalSold,
          'Penjualan/Hari (ADS)': item.ads,
          'Rata-rata Kekosongan (%)': item.avgStockoutRate,
          'Cabang Terparah': item.worstOutlet,
          'Hari Kosong Terparah': item.maxDaysOutOfStock,
          'Status': item.isChronic ? 'Kronis' : (item.avgStockoutRate >= 10 ? 'Waspada' : 'Aman')
        }));

        const ws = XLSX.utils.json_to_sheet(dataToExport);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Riwayat_Stockout');
        const filename = `Riwayat_Stockout_${stockoutData.days}hari.xlsx`;
        XLSX.writeFile(wb, filename);
      });
    }
  }

  // ============================================================
  // TAB 6: ANALISA ABC & AGING STOK
  // ============================================================
  let abcAgingData = null;

  async function loadABCAgingData() {
    const tableBody = document.getElementById('abc-table-body');
    if (!tableBody) return;

    try {
      tableBody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 40px; color: var(--text-muted);"><i data-lucide="loader-2" class="spin"></i> Memuat analisa ABC & aging stok...</td></tr>`;
      if (window.lucide) lucide.createIcons();

      const days = document.getElementById('abc-days-filter')?.value || 90;
      const res = await fetch(`/api/analytics/abc-aging?days=${encodeURIComponent(days)}`);
      const json = await res.json();

      if (!json.success || !json.data) throw new Error(json.message || 'Gagal mengambil data ABC & aging');

      abcAgingData = json.data;
      populateCategoryFilter('abc-category-filter', abcAgingData.availableItemGroups);
      renderABCTable();
    } catch (err) {
      console.error('ABC/Aging load error:', err);
      tableBody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 40px; color: var(--status-danger);">Gagal memuat analisa: ${err.message}</td></tr>`;
    }
  }

  const AGING_BUCKET_BADGES = {
    FRESH: '<span class="status-badge" style="background: rgba(16, 185, 129, 0.12); color: var(--status-success);">🟢 Segar</span>',
    AGING_30_60: '<span class="status-badge badge-med-urgency">🟡 31-60 Hr</span>',
    AGING_60_90: '<span class="status-badge" style="background: rgba(245, 158, 11, 0.15); color: var(--status-warning);">🟠 61-90 Hr</span>',
    DEAD_STOCK: '<span class="status-badge badge-high-urgency">🔴 Dead Stock</span>',
    NEVER_SOLD: '<span class="status-badge" style="background: rgba(107, 114, 128, 0.15); color: var(--text-muted);">⚪ Belum Pernah</span>'
  };

  function renderABCTable() {
    const tableBody = document.getElementById('abc-table-body');
    if (!tableBody || !abcAgingData || !abcAgingData.items) return;

    const items = abcAgingData.items;
    const classACount = items.filter(i => i.abcClass === 'A').length;
    const deadStockItems = items.filter(i => i.agingBucket === 'DEAD_STOCK');
    const neverSoldItems = items.filter(i => i.agingBucket === 'NEVER_SOLD');
    const deadValue = deadStockItems.reduce((s, i) => s + i.estimatedValue, 0) + neverSoldItems.reduce((s, i) => s + i.estimatedValue, 0);

    const statDeadValue = document.getElementById('stat-abc-deadvalue');
    const statClassA = document.getElementById('stat-abc-classa');
    const statDeadCount = document.getElementById('stat-abc-deadcount');
    const statNeverSold = document.getElementById('stat-abc-neversold');
    const badge = document.getElementById('badge-deadstock-count');

    if (statDeadValue) statDeadValue.textContent = `Rp ${deadValue.toLocaleString('id-ID')}`;
    if (statClassA) statClassA.textContent = classACount.toLocaleString('id-ID');
    if (statDeadCount) statDeadCount.textContent = deadStockItems.length.toLocaleString('id-ID');
    if (statNeverSold) statNeverSold.textContent = neverSoldItems.length.toLocaleString('id-ID');
    if (badge) badge.textContent = deadStockItems.length + neverSoldItems.length;

    const classFilter = document.getElementById('abc-class-filter')?.value || 'ALL';
    const agingFilter = document.getElementById('abc-aging-filter')?.value || 'ALL';
    const categoryFilter = document.getElementById('abc-category-filter')?.value || 'ALL';
    const query = (document.getElementById('abc-search-input')?.value || '').toLowerCase().trim();

    let filtered = items.filter(item => {
      if (classFilter !== 'ALL' && item.abcClass !== classFilter) return false;
      if (agingFilter !== 'ALL' && item.agingBucket !== agingFilter) return false;
      if (categoryFilter !== 'ALL' && item.itemGroup !== categoryFilter) return false;
      if (query && !item.name.toLowerCase().includes(query) && !item.code.toLowerCase().includes(query)) return false;
      return true;
    });

    filtered = applyColumnSort(filtered, 'abc-table-body');

    if (filtered.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 40px; color: var(--text-muted);">Tidak ada data yang sesuai filter.</td></tr>`;
      return;
    }

    setVirtualItemsAndRender('abc-table-body', filtered, 10, buildABCRowHtml);
  }

  // Extracted from renderABCTable so the virtual scroller can call it
  // per-visible-row instead of building HTML for the entire filtered list.
  function buildABCRowHtml(item, idx) {
    const classColor = item.abcClass === 'A' ? 'var(--status-success)' : item.abcClass === 'B' ? 'var(--status-warning)' : item.abcClass === 'C' ? 'var(--text-secondary)' : 'var(--text-muted)';
    const agingCell = `${AGING_BUCKET_BADGES[item.agingBucket] || ''}${!item.neverSold ? `<div style="margin-top: 3px; color: var(--text-secondary); font-size: 11px;">${item.agingDays} hari</div>` : ''}`;

    return `
      <tr>
        <td style="text-align: center; color: var(--text-muted);">${idx + 1}</td>
        <td style="font-family: monospace; font-size: 12px;">${escapeHtml(item.code)}</td>
        <td style="font-weight: 700;">${escapeHtml(item.name)}</td>
        <td>
          <div style="font-size: 11.5px; color: var(--accent-cyan);">${escapeHtml(item.merk || '-')}</div>
          <div style="font-size: 10px; color: var(--text-muted);">${escapeHtml(item.itemGroup || '-')}</div>
        </td>
        <td style="text-align: right; font-weight: 700;">${item.currentStock.toLocaleString('id-ID')}</td>
        <td style="text-align: center; font-weight: 800; color: ${classColor};">${item.abcClass}</td>
        <td style="text-align: right; color: var(--status-success);">Rp ${item.revenueInWindow.toLocaleString('id-ID')}</td>
        <td style="font-size: 11.5px;">${item.neverSold ? '-' : formatDateDisplay(item.lastSaleDate)}</td>
        <td style="text-align: right;">${agingCell}</td>
        <td style="text-align: right; font-weight: 800; color: var(--accent-cyan);">Rp ${item.estimatedValue.toLocaleString('id-ID')}</td>
      </tr>
    `;
  }

  function setupABCControls() {
    const daysFilter = document.getElementById('abc-days-filter');
    const classFilter = document.getElementById('abc-class-filter');
    const agingFilter = document.getElementById('abc-aging-filter');
    const searchInput = document.getElementById('abc-search-input');
    const btnExport = document.getElementById('btn-export-abc');

    const categoryFilter = document.getElementById('abc-category-filter');

    initSortableTable('abc-table-body', renderABCTable);
    setupVirtualScroll('abc-table-body', 10, buildABCRowHtml);

    if (daysFilter) daysFilter.addEventListener('change', loadABCAgingData);
    if (classFilter) classFilter.addEventListener('change', renderABCTable);
    if (agingFilter) agingFilter.addEventListener('change', renderABCTable);
    if (categoryFilter) categoryFilter.addEventListener('change', renderABCTable);
    if (searchInput) searchInput.addEventListener('input', renderABCTable);

    if (btnExport) {
      btnExport.addEventListener('click', async () => {
        if (!abcAgingData || !abcAgingData.items || abcAgingData.items.length === 0) {
          alert('Tidak ada data ABC & aging untuk diekspor.');
          return;
        }
        try { await ensureXLSX(); } catch (e) { alert('Pustaka ekspor Excel gagal dimuat. Periksa koneksi internet Anda.'); return; }
        const dataToExport = abcAgingData.items.map((item, i) => ({
          'No': i + 1,
          'Kode Item': item.code,
          'Nama Barang': item.name,
          'Merk': item.merk,
          'Kategori': item.itemGroup,
          'Stok Saat Ini': item.currentStock,
          'Kelas ABC': item.abcClass,
          'Kontribusi Omzet': item.revenueInWindow,
          'Terakhir Terjual': item.neverSold ? 'Belum Pernah' : item.lastSaleDate,
          'Umur Stok (Hari)': item.neverSold ? '-' : item.agingDays,
          'Status Aging': item.agingBucket,
          'Estimasi Nilai Tertahan': item.estimatedValue
        }));
        const ws = XLSX.utils.json_to_sheet(dataToExport);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'ABC_Aging_Stok');
        const filename = `Analisa_ABC_Aging_${abcAgingData.days}hari.xlsx`;
        XLSX.writeFile(wb, filename);
      });
    }
  }

  // ============================================================
  // TAB 7: PERBANDINGAN PERFORMA ANTAR-CABANG
  // ============================================================
  let outletPerfData = null;

  async function loadOutletPerformanceData() {
    const tableBody = document.getElementById('outlet-table-body');
    if (!tableBody) return;

    try {
      tableBody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 40px; color: var(--text-muted);"><i data-lucide="loader-2" class="spin"></i> Memuat performa cabang...</td></tr>`;
      if (window.lucide) lucide.createIcons();

      const days = document.getElementById('outlet-days-filter')?.value || 30;
      const category = document.getElementById('outlet-category-filter')?.value || 'ALL';
      const categoryParam = category !== 'ALL' ? `&itemGroup=${encodeURIComponent(category)}` : '';
      const res = await fetch(`/api/analytics/outlet-performance?days=${encodeURIComponent(days)}${categoryParam}`);
      const json = await res.json();

      if (!json.success || !json.data) throw new Error(json.message || 'Gagal mengambil data performa cabang');

      outletPerfData = json.data;
      populateCategoryFilter('outlet-category-filter', outletPerfData.availableItemGroups);
      renderOutletTable();
    } catch (err) {
      console.error('Outlet performance load error:', err);
      tableBody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 40px; color: var(--status-danger);">Gagal memuat performa cabang: ${err.message}</td></tr>`;
    }
  }

  function renderOutletTable() {
    const tableBody = document.getElementById('outlet-table-body');
    if (!tableBody || !outletPerfData || !outletPerfData.outlets) return;

    const outlets = outletPerfData.outlets;
    const topOutlet = outlets[0];
    const attentionCount = outlets.filter(o => o.needsAttention).length;

    const statTop = document.getElementById('stat-outlet-top');
    const statAttention = document.getElementById('stat-outlet-attention');
    const statRevenue = document.getElementById('stat-outlet-revenue');
    const statAvgStockout = document.getElementById('stat-outlet-avgstockout');

    if (statTop) statTop.textContent = topOutlet ? topOutlet.outlet : '-';
    if (statAttention) statAttention.textContent = attentionCount;
    if (statRevenue) statRevenue.textContent = `Rp ${outletPerfData.totalNetworkRevenue.toLocaleString('id-ID')}`;
    if (statAvgStockout) statAvgStockout.textContent = `${outletPerfData.avgStockoutRate}%`;

    const statusFilter = document.getElementById('outlet-status-filter')?.value || 'ALL';
    const query = (document.getElementById('outlet-search-input')?.value || '').toLowerCase().trim();

    let filtered = outlets.filter(o => {
      if (statusFilter === 'ATTENTION' && !o.needsAttention) return false;
      if (query && !o.outlet.toLowerCase().includes(query)) return false;
      return true;
    });

    filtered = applyColumnSort(filtered, 'outlet-table-body');

    if (filtered.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 40px; color: var(--text-muted);">Tidak ada cabang yang sesuai filter.</td></tr>`;
      return;
    }

    let rowsHtml = '';
    filtered.forEach(o => {
      const statusBadge = o.needsAttention
        ? `<span class="status-badge badge-high-urgency">🔴 Perlu Perhatian</span>`
        : `<span class="status-badge" style="background: rgba(16, 185, 129, 0.12); color: var(--status-success);">🟢 Sehat</span>`;

      rowsHtml += `
        <tr>
          <td style="text-align: center; color: var(--text-muted); font-weight: 700;">#${o.rank}</td>
          <td style="font-weight: 700;">${escapeHtml(o.outlet)}</td>
          <td style="text-align: right; font-weight: 700; color: var(--status-success);">Rp ${o.revenue.toLocaleString('id-ID')}</td>
          <td style="text-align: right;">Rp ${o.profit.toLocaleString('id-ID')}</td>
          <td style="text-align: right;">${o.qty.toLocaleString('id-ID')}</td>
          <td style="text-align: right;">${o.txCount.toLocaleString('id-ID')}</td>
          <td style="text-align: right;">${o.currentStock.toLocaleString('id-ID')}</td>
          <td style="text-align: right; font-weight: 700; color: var(--accent-cyan);">${o.revenueSharePct}%</td>
          <td style="text-align: right; font-weight: 700; color: ${o.stockoutRate >= 20 ? 'var(--status-danger)' : 'var(--text-primary)'};">${o.stockoutRate}%</td>
          <td style="text-align: center;">${statusBadge}</td>
        </tr>
      `;
    });

    tableBody.innerHTML = rowsHtml;
  }

  function setupOutletPerformanceControls() {
    const daysFilter = document.getElementById('outlet-days-filter');
    const categoryFilter = document.getElementById('outlet-category-filter');
    const statusFilter = document.getElementById('outlet-status-filter');
    const searchInput = document.getElementById('outlet-search-input');
    const btnExport = document.getElementById('btn-export-outlet');

    initSortableTable('outlet-table-body', renderOutletTable);

    if (daysFilter) daysFilter.addEventListener('change', loadOutletPerformanceData);
    if (categoryFilter) categoryFilter.addEventListener('change', loadOutletPerformanceData);
    if (statusFilter) statusFilter.addEventListener('change', renderOutletTable);
    if (searchInput) searchInput.addEventListener('input', renderOutletTable);

    if (btnExport) {
      btnExport.addEventListener('click', async () => {
        if (!outletPerfData || !outletPerfData.outlets || outletPerfData.outlets.length === 0) {
          alert('Tidak ada data performa cabang untuk diekspor.');
          return;
        }
        try { await ensureXLSX(); } catch (e) { alert('Pustaka ekspor Excel gagal dimuat. Periksa koneksi internet Anda.'); return; }
        const dataToExport = outletPerfData.outlets.map(o => ({
          'Rank': o.rank,
          'Cabang': o.outlet,
          'Omzet': o.revenue,
          'Profit': o.profit,
          'Qty Terjual': o.qty,
          'Jumlah Transaksi': o.txCount,
          'Stok Saat Ini': o.currentStock,
          'Kontribusi Omzet (%)': o.revenueSharePct,
          'Tingkat Kekosongan (%)': o.stockoutRate,
          'Status': o.needsAttention ? 'Perlu Perhatian' : 'Sehat'
        }));
        const ws = XLSX.utils.json_to_sheet(dataToExport);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Performa_Cabang');
        const categorySuffix = outletPerfData.itemGroup ? `_${outletPerfData.itemGroup.replace(/\s+/g, '_')}` : '';
        const filename = `Performa_Cabang_${outletPerfData.days}hari${categorySuffix}.xlsx`;
        XLSX.writeFile(wb, filename);
      });
    }
  }

  // ============================================================
  // TAB 8: TRACKING SUPPLIER / VENDOR
  // ============================================================
  let vendorAnalysisData = null;

  async function loadVendorAnalysisData() {
    const tableBody = document.getElementById('vendor-table-body');
    if (!tableBody) return;

    try {
      tableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 40px; color: var(--text-muted);"><i data-lucide="loader-2" class="spin"></i> Memuat rekap vendor...</td></tr>`;
      if (window.lucide) lucide.createIcons();

      const days = document.getElementById('vendor-days-filter')?.value || 90;
      const res = await fetch(`/api/analytics/vendor-analysis?days=${encodeURIComponent(days)}`);
      const json = await res.json();

      if (!json.success || !json.data) throw new Error(json.message || 'Gagal mengambil data vendor');

      vendorAnalysisData = json.data;
      renderVendorTable();
    } catch (err) {
      console.error('Vendor analysis load error:', err);
      tableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 40px; color: var(--status-danger);">Gagal memuat rekap vendor: ${err.message}</td></tr>`;
    }
  }

  function renderVendorTable() {
    const tableBody = document.getElementById('vendor-table-body');
    const gapTableBody = document.getElementById('vendor-pricegap-table-body');
    if (!tableBody || !vendorAnalysisData) return;

    const vendors = vendorAnalysisData.vendors || [];
    const priceGapItems = vendorAnalysisData.priceGapItems || [];
    const totalSpend = vendors.reduce((s, v) => s + v.totalSpend, 0);
    const biggestVendor = vendors[0];

    const statCount = document.getElementById('stat-vendor-count');
    const statSpend = document.getElementById('stat-vendor-spend');
    const statBiggest = document.getElementById('stat-vendor-biggest');
    const statPriceGap = document.getElementById('stat-vendor-pricegap');

    if (statCount) statCount.textContent = vendors.length;
    if (statSpend) statSpend.textContent = `Rp ${totalSpend.toLocaleString('id-ID')}`;
    if (statBiggest) statBiggest.textContent = biggestVendor ? biggestVendor.vendor : '-';
    if (statPriceGap) statPriceGap.textContent = priceGapItems.length;

    const query = (document.getElementById('vendor-search-input')?.value || '').toLowerCase().trim();
    let filtered = vendors.filter(v => !query || v.vendor.toLowerCase().includes(query));
    filtered = applyColumnSort(filtered, 'vendor-table-body');

    if (filtered.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 40px; color: var(--text-muted);">Tidak ada vendor yang sesuai filter.</td></tr>`;
    } else {
      let rowsHtml = '';
      filtered.forEach((v, idx) => {
        rowsHtml += `
          <tr>
            <td style="text-align: center; color: var(--text-muted);">${idx + 1}</td>
            <td style="font-weight: 700;">${escapeHtml(v.vendor)}</td>
            <td style="text-align: right;">${v.itemsSuppliedCount.toLocaleString('id-ID')}</td>
            <td style="text-align: right;">${v.totalQty.toLocaleString('id-ID')}</td>
            <td style="text-align: right; font-weight: 700; color: var(--status-success);">Rp ${v.totalSpend.toLocaleString('id-ID')}</td>
            <td style="text-align: right;">${v.invoiceCount.toLocaleString('id-ID')}</td>
            <td style="font-size: 11.5px;">${formatDateDisplay(v.lastPurchaseDate)}</td>
            <td style="text-align: right; font-weight: 700; color: var(--accent-cyan);">${v.cheapestOnCount}</td>
          </tr>
        `;
      });
      tableBody.innerHTML = rowsHtml;
    }

    if (gapTableBody) {
      if (priceGapItems.length === 0) {
        gapTableBody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 30px; color: var(--text-muted);">Tidak ada selisih harga signifikan antar vendor untuk periode ini.</td></tr>`;
      } else {
        let gapHtml = '';
        applyColumnSort(priceGapItems, 'vendor-pricegap-table-body').forEach(g => {
          gapHtml += `
            <tr>
              <td style="font-family: monospace; font-size: 12px;">${escapeHtml(g.itemCode)}</td>
              <td style="font-weight: 700;">${escapeHtml(g.itemName)}</td>
              <td style="color: var(--status-success);">${escapeHtml(g.cheapestVendor)}</td>
              <td style="text-align: right;">Rp ${g.cheapestPrice.toLocaleString('id-ID')}</td>
              <td style="color: var(--status-danger);">${escapeHtml(g.priciestVendor)}</td>
              <td style="text-align: right;">Rp ${g.priciestPrice.toLocaleString('id-ID')}</td>
              <td style="text-align: right; font-weight: 800; color: var(--status-warning);">+${g.spreadPct}%</td>
            </tr>
          `;
        });
        gapTableBody.innerHTML = gapHtml;
      }
    }
  }

  function setupVendorAnalysisControls() {
    const daysFilter = document.getElementById('vendor-days-filter');
    const searchInput = document.getElementById('vendor-search-input');
    const btnExport = document.getElementById('btn-export-vendor');

    initSortableTable('vendor-table-body', renderVendorTable);
    initSortableTable('vendor-pricegap-table-body', renderVendorTable);

    if (daysFilter) daysFilter.addEventListener('change', loadVendorAnalysisData);
    if (searchInput) searchInput.addEventListener('input', renderVendorTable);

    if (btnExport) {
      btnExport.addEventListener('click', async () => {
        if (!vendorAnalysisData || !vendorAnalysisData.vendors || vendorAnalysisData.vendors.length === 0) {
          alert('Tidak ada data vendor untuk diekspor.');
          return;
        }
        try { await ensureXLSX(); } catch (e) { alert('Pustaka ekspor Excel gagal dimuat. Periksa koneksi internet Anda.'); return; }
        const dataToExport = vendorAnalysisData.vendors.map((v, i) => ({
          'No': i + 1,
          'Vendor': v.vendor,
          'Item Disuplai': v.itemsSuppliedCount,
          'Total Qty Dibeli': v.totalQty,
          'Total Belanja': v.totalSpend,
          'Jumlah Invoice': v.invoiceCount,
          'Terakhir Beli': v.lastPurchaseDate,
          'Item Termurah (Count)': v.cheapestOnCount
        }));
        const ws = XLSX.utils.json_to_sheet(dataToExport);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Rekap_Vendor');
        const filename = `Rekap_Vendor_${vendorAnalysisData.days}hari.xlsx`;
        XLSX.writeFile(wb, filename);
      });
    }
  }

  // ============================================================
  // TAB 9: TREN PENJUALAN & PEMBELIAN PER PERIODE
  // Buckets the full sales/purchase history into fixed periods (daily, every
  // 3 days, weekly, biweekly, or real calendar months) so patterns across the
  // daily uploads become visible over time, not just a single-window average.
  // ============================================================
  let trendData = null;
  let trendChartInstance = null;

  const TREND_BUCKET_LABELS = {
    day: 'Harian',
    '3day': '3 Harian',
    week: 'Mingguan',
    '2week': '2 Mingguan',
    month: 'Bulanan'
  };

  async function loadTrendAnalysisData() {
    const tableBody = document.getElementById('trend-table-body');
    if (!tableBody) return;

    try {
      tableBody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 40px; color: var(--text-muted);"><i data-lucide="loader-2" class="spin"></i> Memuat tren periode...</td></tr>`;
      if (window.lucide) lucide.createIcons();

      const bucket = document.getElementById('trend-bucket-filter')?.value || 'week';
      const category = document.getElementById('trend-category-filter')?.value || 'ALL';
      const categoryParam = category !== 'ALL' ? `&itemGroup=${encodeURIComponent(category)}` : '';
      const res = await fetch(`/api/analytics/trend?bucket=${encodeURIComponent(bucket)}${categoryParam}`);
      const json = await res.json();

      if (!json.success || !json.data) throw new Error(json.message || 'Gagal mengambil data tren');

      trendData = json.data;
      populateCategoryFilter('trend-category-filter', trendData.availableItemGroups);

      const noteEl = document.getElementById('trend-category-note');
      if (noteEl) noteEl.style.display = trendData.itemGroup ? 'block' : 'none';

      renderTrendChart();
      renderTrendTable();
    } catch (err) {
      console.error('Trend analysis load error:', err);
      tableBody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 40px; color: var(--status-danger);">Gagal memuat tren periode: ${err.message}</td></tr>`;
    }
  }

  function formatTrendBucketLabel(bucket, bucketType) {
    if (bucketType === 'month') {
      const [y, m] = bucket.label.split('-');
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
      return `${monthNames[parseInt(m, 10) - 1]} ${y}`;
    }
    if (bucket.startDate === bucket.endDate) return formatDateDisplay(bucket.startDate);
    return `${formatDateDisplay(bucket.startDate)} - ${formatDateDisplay(bucket.endDate)}`;
  }

  function renderTrendChart() {
    const canvas = document.getElementById('trendChart');
    if (!canvas || !trendData) return;

    const buckets = trendData.buckets || [];
    const totalRevenue = buckets.reduce((s, b) => s + b.revenue, 0);
    const totalProfit = buckets.reduce((s, b) => s + b.profit, 0);
    const totalPurchase = buckets.reduce((s, b) => s + b.purchAmount, 0);
    const purchaseAvailable = trendData.purchaseDataAvailable !== false;

    const statRevenue = document.getElementById('stat-trend-revenue');
    const statProfit = document.getElementById('stat-trend-profit');
    const statPurchase = document.getElementById('stat-trend-purchase');
    const statBuckets = document.getElementById('stat-trend-buckets');
    if (statRevenue) statRevenue.textContent = `Rp ${totalRevenue.toLocaleString('id-ID')}`;
    if (statProfit) statProfit.textContent = `Rp ${totalProfit.toLocaleString('id-ID')}`;
    if (statPurchase) statPurchase.textContent = purchaseAvailable ? `Rp ${totalPurchase.toLocaleString('id-ID')}` : 'Tidak tersedia';
    if (statBuckets) statBuckets.textContent = buckets.length;

    if (trendChartInstance) trendChartInstance.destroy();
    if (buckets.length === 0) return;

    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const gridColor = isLight ? 'rgba(15, 23, 42, 0.05)' : 'rgba(255, 255, 255, 0.04)';
    const tickColor = isLight ? '#475569' : '#9ca3af';
    const tooltipBg = isLight ? 'rgba(255, 255, 255, 0.98)' : 'rgba(17, 25, 40, 0.95)';
    const tooltipBorder = isLight ? 'rgba(15, 23, 42, 0.1)' : 'rgba(6, 182, 212, 0.2)';
    const tooltipTextPrimary = isLight ? '#0f172a' : '#f3f4f6';
    const tooltipTextSecondary = isLight ? '#475569' : '#9ca3af';

    const ctx = canvas.getContext('2d');
    trendChartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: buckets.map(b => formatTrendBucketLabel(b, trendData.bucketType)),
        datasets: [
          {
            label: 'Omzet Penjualan',
            data: buckets.map(b => b.revenue),
            borderColor: '#06b6d4',
            backgroundColor: 'rgba(6, 182, 212, 0.12)',
            fill: true,
            tension: 0.3
          },
          {
            label: 'Profit',
            data: buckets.map(b => b.profit),
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.08)',
            fill: true,
            tension: 0.3
          },
          // Purchase data has no category field, so this line is only meaningful
          // (and only included) when no category filter is active.
          ...(purchaseAvailable ? [{
            label: 'Total Pembelian',
            data: buckets.map(b => b.purchAmount),
            borderColor: '#a855f7',
            backgroundColor: 'rgba(168, 85, 247, 0.08)',
            fill: true,
            tension: 0.3
          }] : [])
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: tickColor } },
          tooltip: {
            backgroundColor: tooltipBg,
            borderColor: tooltipBorder,
            borderWidth: 1,
            titleColor: tooltipTextPrimary,
            bodyColor: tooltipTextSecondary,
            callbacks: {
              label: (item) => `${item.dataset.label}: Rp ${item.parsed.y.toLocaleString('id-ID')}`
            }
          }
        },
        scales: {
          x: {
            grid: { color: gridColor },
            ticks: { color: tickColor, font: { size: 10 } }
          },
          y: {
            grid: { color: gridColor },
            ticks: {
              color: tickColor,
              callback: (val) => `${(val / 1000).toLocaleString('id-ID')}rb`
            }
          }
        }
      }
    });
  }

  function renderTrendTable() {
    const tableBody = document.getElementById('trend-table-body');
    if (!tableBody || !trendData) return;

    const buckets = trendData.buckets || [];
    if (buckets.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 40px; color: var(--text-muted);">Belum ada data penjualan/pembelian untuk ditampilkan sebagai tren.</td></tr>`;
      return;
    }

    const purchaseAvailable = trendData.purchaseDataAvailable !== false;

    // Most recent period first, easier to spot the latest trend at a glance
    const rows = applyColumnSort([...buckets].reverse(), 'trend-table-body');
    let rowsHtml = '';
    rows.forEach(b => {
      rowsHtml += `
        <tr>
          <td style="font-weight: 700;">${escapeHtml(formatTrendBucketLabel(b, trendData.bucketType))}</td>
          <td style="text-align: right; color: var(--text-muted);">${b.days}</td>
          <td style="text-align: right; font-weight: 700; color: var(--status-success);">Rp ${b.revenue.toLocaleString('id-ID')}</td>
          <td style="text-align: right;">${b.qty.toLocaleString('id-ID')}</td>
          <td style="text-align: right; color: var(--accent-cyan);">Rp ${b.profit.toLocaleString('id-ID')}</td>
          <td style="text-align: right; color: var(--accent-purple);">${purchaseAvailable ? `Rp ${b.purchAmount.toLocaleString('id-ID')}` : '-'}</td>
          <td style="text-align: right;">${purchaseAvailable ? b.purchQty.toLocaleString('id-ID') : '-'}</td>
        </tr>
      `;
    });

    tableBody.innerHTML = rowsHtml;
  }

  function setupTrendAnalysisControls() {
    const bucketFilter = document.getElementById('trend-bucket-filter');
    const categoryFilter = document.getElementById('trend-category-filter');
    const btnExport = document.getElementById('btn-export-trend');

    initSortableTable('trend-table-body', renderTrendTable);

    if (bucketFilter) bucketFilter.addEventListener('change', loadTrendAnalysisData);
    if (categoryFilter) categoryFilter.addEventListener('change', loadTrendAnalysisData);

    if (btnExport) {
      btnExport.addEventListener('click', async () => {
        if (!trendData || !trendData.buckets || trendData.buckets.length === 0) {
          alert('Tidak ada data tren untuk diekspor.');
          return;
        }
        try { await ensureXLSX(); } catch (e) { alert('Pustaka ekspor Excel gagal dimuat. Periksa koneksi internet Anda.'); return; }
        const purchaseAvailable = trendData.purchaseDataAvailable !== false;
        const dataToExport = trendData.buckets.map(b => ({
          'Periode': formatTrendBucketLabel(b, trendData.bucketType),
          'Hari Tercatat': b.days,
          'Omzet Penjualan': b.revenue,
          'Qty Terjual': b.qty,
          'Profit': b.profit,
          'Total Pembelian': purchaseAvailable ? b.purchAmount : 'Tidak tersedia (difilter kategori)',
          'Qty Dibeli': purchaseAvailable ? b.purchQty : '-'
        }));
        const ws = XLSX.utils.json_to_sheet(dataToExport);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Tren_Periode');
        const categorySuffix = trendData.itemGroup ? `_${trendData.itemGroup.replace(/\s+/g, '_')}` : '';
        const filename = `Tren_${TREND_BUCKET_LABELS[trendData.bucketType] || trendData.bucketType}${categorySuffix}.xlsx`;
        XLSX.writeFile(wb, filename);
      });
    }
  }

  // ============================================================
  // TAB 10: MULTI-TYPE IMPORT CENTER
  // ============================================================
  function setupImportCenter() {
    setupSpecificDropzone('dropzone-stock', 'input-file-stock', '/api/upload', 'stok');
    setupSpecificDropzone('dropzone-sales', 'input-file-sales', '/api/upload-sales', 'penjualan');
    setupSpecificDropzone('dropzone-purchases', 'input-file-purchases', '/api/upload-purchases', 'pembelian');
    setupSpecificDropzone('dropzone-auto', 'input-file-auto', '/api/upload-auto', 'otomatis');

    const btnClearImportDate = document.getElementById('btn-clear-import-date');
    if (btnClearImportDate) {
      btnClearImportDate.addEventListener('click', () => {
        const dateInput = document.getElementById('import-custom-date');
        if (dateInput) dateInput.value = '';
      });
    }
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
    const customDate = document.getElementById('import-custom-date')?.value || '';
    showStatus(
      customDate
        ? `Mengunggah berkas ${label}: "${file.name}" untuk tanggal ${formatDateDisplay(customDate)}...`
        : `Mengunggah berkas ${label}: "${file.name}"...`,
      'info'
    );

    const reader = new FileReader();
    const isBinaryExcel = file.name.endsWith('.xls') || file.name.endsWith('.xlsx');

    reader.onload = async (e) => {
      try {
        let payload = { filename: file.name };
        if (customDate) payload.customDate = customDate;

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
    const stockContainer = document.getElementById('import-history-stock');
    const salesContainer = document.getElementById('import-history-sales');
    const purchContainer = document.getElementById('import-history-purchases');

    // 0. Stock Reports
    if (stockContainer) {
      try {
        const res = await fetch('/api/dates');
        const json = await res.json();
        if (json.success && json.dates.length > 0) {
          stockContainer.innerHTML = json.dates.map(d => `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: rgba(255,255,255,0.03); border-radius: 8px; margin-bottom: 8px; font-size: 12px;">
              <div>
                <strong style="color: var(--text-primary);">${escapeHtml(d.report_date)}</strong>
                <span style="color: var(--text-secondary); margin-left: 8px;">(${d.total_items.toLocaleString('id-ID')} item, ${d.total_stock.toLocaleString('id-ID')} pcs, ${d.total_outlets} outlet)</span>
                <div style="color: var(--text-muted); font-size: 11px;">Berkas: ${escapeHtml(d.filename || '-')}</div>
              </div>
              <button class="btn-mini-danger" style="padding: 4px 8px; font-size: 11px;" data-batch-type="stock" data-batch-date="${escapeHtml(d.report_date)}">
                Hapus
              </button>
            </div>
          `).join('');
        } else {
          stockContainer.innerHTML = '<p style="color: var(--text-muted); font-size: 12px;">Belum ada riwayat stok yang diimpor.</p>';
        }
      } catch (e) {
        stockContainer.innerHTML = `<p style="color: var(--status-danger); font-size: 12px;">Gagal memuat: ${e.message}</p>`;
      }
    }

    // 1. Sales Batches
    if (salesContainer) {
      try {
        const res = await fetch('/api/sales/batches');
        const json = await res.json();
        if (json.success && json.batches.length > 0) {
          salesContainer.innerHTML = json.batches.map(b => `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: rgba(255,255,255,0.03); border-radius: 8px; margin-bottom: 8px; font-size: 12px;">
              <div>
                <strong style="color: var(--text-primary);">${escapeHtml(b.batch_date)}</strong>
                <span style="color: var(--text-secondary); margin-left: 8px;">(${b.total_rows.toLocaleString('id-ID')} transaksi, ${b.total_qty.toLocaleString('id-ID')} pcs)</span>
                <div style="color: var(--text-muted); font-size: 11px;">Berkas: ${escapeHtml(b.filename || '-')}</div>
              </div>
              <button class="btn-mini-danger" style="padding: 4px 8px; font-size: 11px;" data-batch-type="sales" data-batch-date="${escapeHtml(b.batch_date)}">
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
                <strong style="color: var(--text-primary);">${escapeHtml(b.batch_date)}</strong>
                <span style="color: var(--text-secondary); margin-left: 8px;">(${b.total_rows.toLocaleString('id-ID')} baris, ${b.total_qty.toLocaleString('id-ID')} pcs)</span>
                <div style="color: var(--text-muted); font-size: 11px;">Berkas: ${escapeHtml(b.filename || '-')}</div>
              </div>
              <button class="btn-mini-danger" style="padding: 4px 8px; font-size: 11px;" data-batch-type="purchases" data-batch-date="${escapeHtml(b.batch_date)}">
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

    // Delete buttons are rebuilt on every load (innerHTML replaced above), so
    // a delegated listener on the stable container — wired once per container
    // — is used instead of re-attaching one per button, and instead of the
    // inline onclick="..." string-concatenation this used to be (unsafe if a
    // batch's date ever contained a quote character; see isValidDateString
    // on the server for where that's now rejected at upload time too).
    [stockContainer, salesContainer, purchContainer].forEach(container => {
      if (!container || container.dataset.deleteWired) return;
      container.dataset.deleteWired = 'true';
      container.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-batch-type]');
        if (!btn) return;
        window._deleteBatch(btn.dataset.batchType, btn.dataset.batchDate);
      });
    });
  }

  // Global batch deletion helper
  window._deleteBatch = async function(type, date) {
    if (!confirm(`Hapus batch ${type} untuk tanggal ${date}?`)) return;
    try {
      const endpoint = type === 'stock' ? `/api/report?date=${date}`
        : type === 'sales' ? `/api/sales?date=${date}`
        : `/api/purchases?date=${date}`;
      const res = await fetch(endpoint, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        alert(json.message);
        loadImportBatches();
        loadRebalanceData();
        loadPOData();
        if (type === 'stock') checkBackendAndLoad();
      } else {
        alert(json.message || 'Gagal menghapus batch');
      }
    } catch (e) {
      alert('Error: ' + e.message);
    }
  };
});

