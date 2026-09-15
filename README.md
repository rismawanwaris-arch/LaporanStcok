# 📊 Voucher Stock & Sales Analytics (Smart Rebalancing & Panduan ZimaOS)

Aplikasi terpadu analisa stok, penjualan, dan pembelian voucher multi-outlet dari laporan Bee Accounting. Dilengkapi **Database SQLite terintegrasi**, **Mesin Rekomendasi Transfer Antar-Cabang (Smart Rebalancing)**, **Analisa Ketahanan Stok (Days of Coverage)**, **Rencana Belanja (PO Planner)**, tabel ultra-rapat dengan drag-and-drop kolom outlet, mode fullscreen, dan ekspor ke Excel (.xlsx).

---

## 🌟 Fitur Utama

1. **Mesin Rekomendasi Transfer Antar-Cabang (Smart Rebalancing)**:
   - **Hemat Modal Belanja**: Sebelum memesan voucher baru ke distributor, sistem mencocokkan cabang yang kekurangan stok (*stockout* / kritis < 2 hari) dengan cabang yang kelebihan stok (*overstock* / *dead stock*).
   - Menghitung jumlah PCS mutasi optimal per item & per cabang.
   - Tombol **Ekspor Slip Transfer (XLSX)** sekali klik untuk surat jalan mutasi fisik.

2. **Analisa Ketahanan Stok (Days of Coverage / DoC)**:
   - Menghitung rata-rata penjualan harian (ADS) dan sisa hari ketahanan stok per item dan per cabang:
     $$\text{DoC} = \frac{\text{Stok Berjalan}}{\text{Rata-rata Jual Harian}}$$
   - Indikator warna visual: 🔴 Kritis (< 2 hari), 🟡 Waspada (2-5 hari), 🟢 Optimal (6-14 hari), 🔵 Overstock (> 20 hari), ⚪ Dead Stock.

3. **Rencana Pembelian Otomatis (PO Planner)**:
   - Menghitung Titik Pesan Ulang (*Reorder Point / ROP*) dan estimasi kebutuhan order ke supplier jika stok jaringan di bawah batas aman.
   - Tombol **Ekspor Draft PO (XLSX)** langsung siap kirim ke distributor.

4. **Pusat Import Multi-Berkas dengan Deteksi Cerdas**:
   - Mendukung format Excel (`.xls`, `.xlsx`) dan `.csv`.
   - Area seret-lepas khusus untuk:
     - 📦 Laporan Stok Saldo Gudang
     - 📈 Laporan Penjualan Detail (contoh: `14-09-2026.xls`)
     - 🛒 Laporan Pembelian Detail (contoh: `DetailPembelian-*.xls`)
     - ⚡ **Auto-Detect**: Seret berkas apa saja, sistem langsung mengenali jenis laporan secara otomatis!

5. **Database Riwayat Harian (SQLite Persistence)**:
   - Menyimpan seluruh transaksi stok, penjualan, dan pembelian tanpa perlu setup database rumit.
   - Menu **Manajemen Database (Sidebar Drawer)**: statistik ukuran file, unduh cadangan `.db`, pulihkan cadangan, dan kelola batch.

6. **Tabel Stok Ultra-Rapat & Fleksibel**:
   - Kolom outlet cabang dapat digeser urutannya secara manual (*drag-and-drop*).
   - *Double Sticky*: Header outlet tetap diam saat scroll ke bawah, nama barang tetap diam saat scroll ke samping.
   - Mode Fullscreen layar penuh untuk monitor toko / gudang.

---

## 🚀 Panduan Deploy ke ZimaOS / CasaOS

ZimaOS menjalankan aplikasi dalam bentuk Docker Container. Anda dapat mendeploy aplikasi ini menggunakan salah satu dari dua cara berikut:

### Cara 1: Menggunakan ZimaOS / CasaOS Web UI (Paling Mudah)

1. **Buka Dashboard ZimaOS** di browser Anda (contoh: `http://zimaos.local` atau `http://192.168.x.x`).
2. Masuk ke **App Store**, lalu klik tombol **Custom Install** (atau tanda `+` di kanan atas dashboard).
3. Klik tombol **Import** di pojok kanan atas jendela instalasi.
4. Buka berkas [docker-compose.yml](file:///c:/Users/Komputer/Documents/Coding/LaporanStock/docker-compose.yml) dari proyek ini, salin seluruh isinya, lalu tempelkan (*paste*) ke dalam kotak input ZimaOS.
5. Periksa pengaturan:
   - **Title**: Analisa Stok Voucher
   - **Port**: `3500` (Akses web via port 3500)
   - **Volume**: Pastikan path host volume mengarah ke penyimpanan ZimaOS Anda, misalnya `/DATA/AppData/laporan-stock/data` -> `/app/data`.
6. Klik **Submit / Install**. ZimaOS akan otomatis membangun dan menjalankan kontainer.
7. Ikon aplikasi akan muncul di dashboard ZimaOS Anda! Klik ikon tersebut untuk langsung membukanya di `http://<IP-ZIMAOS>:3500`.

---

### Cara 2: Menggunakan Terminal / SSH di ZimaOS

Jika Anda lebih menyukai baris perintah:

1. Clone repositori ke server ZimaOS:
   ```bash
   cd /DATA/AppData
   git clone https://github.com/rismawanwaris-arch/LaporanStcok.git laporan-stock
   cd laporan-stock
   docker compose up -d --build
   ```
2. Buka browser dan akses:
   ```
   http://<IP-ZIMAOS-ANDA>:3500
   ```

---

## 💻 Menjalankan di Komputer Lokal (Windows / Mac / Linux)

Tanpa Docker, Anda juga dapat menjalankannya langsung di komputer lokal menggunakan Node.js:

```bash
# Masuk ke folder proyek
cd c:\Users\Komputer\Documents\Coding\LaporanStock

# Jalankan server
npm start
# atau
node server.js
```

Buka browser di `http://localhost:3000`.

---

## 📖 Cara Penggunaan Sehari-hari

1. **Unggah Laporan Harian**:
   - Cukup seret (*drag-and-drop*) file CSV Bee Accounting harian Anda ke kotak upload di web.
   - Sistem akan otomatis mendeteksi tanggal laporan dari CSV dan menyimpannya ke database.
2. **Melihat Riwayat Tanggal**:
   - Gunakan dropdown **Tanggal** di baris filter untuk memilih tanggal laporan yang ingin Anda tinjau.
3. **Mengatur Urutan Cabang**:
   - Tarik dan geser header outlet cabang ke kiri atau ke kanan sesuai preferensi urutan Anda. Urutan akan tersimpan otomatis.
4. **Membuka Fullscreen**:
   - Klik tombol **Fullscreen** di atas tabel untuk melihat semua data di satu layar penuh.
5. **Ekspor Data**:
   - Klik **Ekspor Excel (XLSX)** untuk mengunduh tabel berformat Excel dengan angka numerik murni.
6. **Menghapus Laporan**:
   - Jika salah mengunggah file, pilih tanggal tersebut di dropdown lalu klik ikon tong sampah merah di sampingnya untuk menghapus dari database.

---

## 💾 Lokasi Data & Cadangan (Backup)

- Seluruh data laporan harian tersimpan dalam satu file SQLite:
  `data/stock_history.db`
- Untuk mencadangkan data, Anda cukup menyalin file `stock_history.db` ke flashdisk, Google Drive, atau harddisk eksternal Anda.

---
*Dibuat & dioptimalkan dengan Google Antigravity IDE.*
