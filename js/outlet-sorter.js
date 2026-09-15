/**
 * OutletSorter
 * Manages the drag-and-drop sorting functionality for outlet columns using SortableJS.
 * Persists the custom ordering inside localStorage.
 */

class OutletSorter {
  /**
   * Initializes sorting on the specified table header row.
   * @param {HTMLElement} headerRowElement - The <tr> element containing the headers
   * @param {string} merkName - The active Merk identifier for scoping the order
   * @param {Function} onOrderChanged - Callback triggered when a drag & drop operation finishes
   */
  constructor(headerRowElement, merkName, onOrderChanged) {
    this.headerRow = headerRowElement;
    this.merkName = merkName;
    this.onOrderChanged = onOrderChanged;
    this.storageKey = `outlet_order_${this.merkName.replace(/\s+/g, '_')}`;
    this.sortableInstance = null;

    this.init();
  }

  /**
   * Initialize SortableJS.
   */
  init() {
    if (typeof Sortable === 'undefined') {
      console.warn('SortableJS is not loaded yet.');
      return;
    }

    // Destroy existing instance if any
    if (this.sortableInstance) {
      this.sortableInstance.destroy();
    }

    // Initialize Sortable on the <tr> element
    this.sortableInstance = new Sortable(this.headerRow, {
      handle: '.drag-handle',       // Drag handle selector inside <th>
      draggable: 'th[data-outlet]', // Only allow dragging TH elements with data-outlet attribute
      animation: 250,               // Smooth animation duration (ms)
      ghostClass: 'drag-ghost',     // Class name for the drop placeholder
      chosenClass: 'drag-chosen',   // Class name for the chosen item
      dragClass: 'drag-dragging',   // Class name for the dragging item
      forceFallback: false,
      
      onStart: (evt) => {
        evt.item.classList.add('is-dragging');
      },

      onEnd: (evt) => {
        evt.item.classList.remove('is-dragging');
        this.saveCurrentOrder();
        if (this.onOrderChanged) {
          this.onOrderChanged(this.getCurrentOrder());
        }
      }
    });
  }

  /**
   * Destroys the SortableJS instance.
   */
  destroy() {
    if (this.sortableInstance) {
      this.sortableInstance.destroy();
      this.sortableInstance = null;
    }
  }

  /**
   * Retrieves the current order of outlets based on the DOM headers.
   * @returns {Array<string>} List of outlet names
   */
  getCurrentOrder() {
    const headers = Array.from(this.headerRow.querySelectorAll('th[data-outlet]'));
    return headers.map(header => header.getAttribute('data-outlet'));
  }

  /**
   * Saves the current DOM order of outlets to localStorage.
   */
  saveCurrentOrder() {
    const order = this.getCurrentOrder();
    localStorage.setItem(this.storageKey, JSON.stringify(order));
  }

  /**
   * Retrieves the saved order of outlets from localStorage.
   * @param {string} merkName - The Merk name to load order for
   * @returns {Array<string>|null} List of outlet names or null if not found
   */
  static getSavedOrder(merkName) {
    const key = `outlet_order_${merkName.replace(/\s+/g, '_')}`;
    const saved = localStorage.getItem(key);
    if (!saved) return null;
    try {
      return JSON.parse(saved);
    } catch (e) {
      console.error('Failed to parse saved outlet order', e);
      return null;
    }
  }

  /**
   * Clears the custom outlet order from localStorage.
   * @param {string} merkName 
   */
  static resetSavedOrder(merkName) {
    const key = `outlet_order_${merkName.replace(/\s+/g, '_')}`;
    localStorage.removeItem(key);
  }

  static sortOutlets(outlets, merkName) {
    const savedOrder = this.getSavedOrder(merkName);
    
    // User's specific preferred order
    const preferredOrder = [
      'GDG', 'ALFA 1', 'ALFA 2', 'ALFA 3', 'ALFA 4', 'ALFA 7', 'ASBER 1 CELL', 'ASBER 2 CELL', 
      'BK JH1 SINOM', 'BK JH2 JTHNDP BAWAH', 'BK8 BAKSAR 1', 'BK9 BAKSAR 2', 'CIKADUT CELL', 
      'CIKADUT CELL 2', 'CISA', 'CICUKANG', 'CIPAGALO', 'PD 1', 'PD 2', 'PD 3', 
      'ALFA 5', 'ALFA 6', 'BK CJMB', 'BK CIPADUNG', 'BK CIPADUNG 2', 'BK 5 CIGER', 
      'BK 6 PANGARITAN', 'BK 7 NAGROG', 'BUNISARI', 'CIPOREAT', 'CL 1', 
      'CL 2', 'CL 3', 'CL 4', 'DM', 'PC 3', 'PC 4', 'PC 5', 'RK', 'SA', 'SS'
    ];

    const activeOrder = savedOrder || preferredOrder;

    const sortedOutlets = [];
    const outletSet = new Set(outlets);

    // 1. Add outlets in their active order (only if they exist in the current data)
    activeOrder.forEach(name => {
      if (outletSet.has(name)) {
        sortedOutlets.push(name);
        outletSet.delete(name);
      }
    });

    // 2. Add any new/remaining outlets that were not in the active order (appended at the end)
    outlets.forEach(name => {
      if (outletSet.has(name)) {
        sortedOutlets.push(name);
      }
    });

    return sortedOutlets;
  }
}

// Export or attach to window
if (typeof module !== 'undefined' && module.exports) {
  module.exports = OutletSorter;
} else {
  window.OutletSorter = OutletSorter;
}
