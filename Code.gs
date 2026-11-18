/**
 * Dashboard Laporan Gangguan
 * Template dashboard monitoring gangguan berbasis Google Apps Script + Google Sheets.
 *
 * Cara pakai singkat:
 *   1. Buat Google Spreadsheet baru → Extensions → Apps Script.
 *   2. Salin Code.gs dan Index.html ke project.
 *   3. Jalankan fungsi `setup()` sekali (izinkan akses).
 *   4. (Opsional) Jalankan `seedDemoData()` untuk mengisi contoh data.
 *   5. Deploy → New deployment → Web app.
 *
 * Lisensi: MIT
 */

const SHEET = {
  LAPORAN: 'Laporan',
  MASTER: 'Master',
  CONFIG: 'Config',
  LOG: 'Log',
};

const HEADERS = [
  'ID', 'Tanggal Lapor', 'Pelapor', 'Kontak', 'Kategori', 'Prioritas',
  'Wilayah', 'Lokasi', 'Latitude', 'Longitude', 'Deskripsi', 'Status',
  'Petugas', 'Tanggal Mulai', 'Tanggal Selesai', 'Catatan', 'Diperbarui',
];

const FIELD_KEYS = [
  'id', 'tanggalLapor', 'pelapor', 'kontak', 'kategori', 'prioritas',
  'wilayah', 'lokasi', 'lat', 'lng', 'deskripsi', 'status',
  'petugas', 'tanggalMulai', 'tanggalSelesai', 'catatan', 'diperbarui',
];

const STATUS = { BARU: 'Baru', PROSES: 'Diproses', SELESAI: 'Selesai', BATAL: 'Dibatalkan' };

const DEFAULT_MASTER = {
  Kategori: ['Listrik Padam', 'Jaringan Internet', 'Air Bersih', 'Jalan Rusak', 'Penerangan Jalan', 'Lainnya'],
  Prioritas: ['Rendah', 'Sedang', 'Tinggi', 'Darurat'],
  Wilayah: ['Wilayah Utara', 'Wilayah Selatan', 'Wilayah Timur', 'Wilayah Barat', 'Wilayah Tengah'],
  Status: [STATUS.BARU, STATUS.PROSES, STATUS.SELESAI, STATUS.BATAL],
  Petugas: ['Tim A', 'Tim B', 'Tim C'],
};

const DEFAULT_CONFIG = [
  ['APP_NAME', 'Dashboard Laporan Gangguan', 'Judul aplikasi'],
  ['ORG_NAME', 'Nama Instansi', 'Nama instansi / organisasi'],
  ['ADMIN_EMAILS', '', 'Email admin, pisahkan dengan koma. Kosongkan = semua pengguna boleh edit & hapus'],
  ['MAP_CENTER', '-2.1316, 106.1169', 'Titik tengah peta (lat, lng)'],
  ['MAP_ZOOM', '11', 'Zoom awal peta'],
  ['SLA_HOURS', '24', 'Target penyelesaian (jam) untuk perhitungan SLA'],
];

/* ------------------------------------------------------------------ */
/* Web app                                                             */
/* ------------------------------------------------------------------ */

function doGet() {
  const cfg = getConfig_();
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(cfg.APP_NAME || 'Dashboard Laporan Gangguan')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Data awal untuk frontend: konfigurasi, master, laporan, info pengguna. */
function getInitialData() {
  ensureSetup_();
  return {
    config: getConfig_(),
    master: getMaster_(),
    reports: getReports_(),
    user: { email: currentEmail_(), isAdmin: isAdmin_() },
    serverTime: new Date().toISOString(),
  };
}

function getReports() {
  return getReports_();
}

/** Membuat laporan baru. */
function createReport(input) {
  const data = sanitize_(input);
  if (!data.pelapor || !data.kategori || !data.lokasi || !data.deskripsi) {
    throw new Error('Pelapor, kategori, lokasi, dan deskripsi wajib diisi.');
  }
  return withLock_(() => {
    const sh = sheet_(SHEET.LAPORAN);
    const now = new Date();
    const report = Object.assign(emptyReport_(), data, {
      id: nextId_(sh, now),
      tanggalLapor: data.tanggalLapor ? new Date(data.tanggalLapor) : now,
      status: STATUS.BARU,
      diperbarui: now,
    });
    sh.appendRow(toRow_(report));
    log_('CREATE', report.id, report.kategori + ' · ' + report.lokasi);
    return serialize_(report);
  });
}

/** Memperbarui laporan (status, petugas, catatan, dan field lain). */
function updateReport(id, patch) {
  const data = sanitize_(patch || {});
  return withLock_(() => {
    const sh = sheet_(SHEET.LAPORAN);
    const rowIndex = findRow_(sh, id);
    if (rowIndex < 0) throw new Error('Laporan ' + id + ' tidak ditemukan.');

    const current = fromRow_(sh.getRange(rowIndex, 1, 1, HEADERS.length).getValues()[0]);
    const now = new Date();
    const next = Object.assign({}, current, data, { id: current.id, diperbarui: now });
    if (data.tanggalLapor) next.tanggalLapor = new Date(data.tanggalLapor);

    if (data.status && data.status !== current.status) {
      if (data.status === STATUS.PROSES && !current.tanggalMulai) next.tanggalMulai = now;
      if (data.status === STATUS.SELESAI) {
        if (!next.tanggalMulai) next.tanggalMulai = now;
        next.tanggalSelesai = now;
      }
      if (data.status === STATUS.BARU || data.status === STATUS.PROSES) next.tanggalSelesai = '';
      log_('STATUS', id, current.status + ' → ' + data.status);
    } else {
      log_('UPDATE', id, Object.keys(data).join(', '));
    }

    sh.getRange(rowIndex, 1, 1, HEADERS.length).setValues([toRow_(next)]);
    return serialize_(next);
  });
}

/** Menghapus laporan (khusus admin bila ADMIN_EMAILS diisi). */
function deleteReport(id) {
  if (!isAdmin_()) throw new Error('Hanya admin yang boleh menghapus laporan.');
  return withLock_(() => {
    const sh = sheet_(SHEET.LAPORAN);
    const rowIndex = findRow_(sh, id);
    if (rowIndex < 0) throw new Error('Laporan ' + id + ' tidak ditemukan.');
    sh.deleteRow(rowIndex);
    log_('DELETE', id, '');
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* Setup & data demo                                                   */
/* ------------------------------------------------------------------ */

/** Jalankan sekali untuk membuat sheet dan pengaturan awal. */
function setup() {
  const ss = SpreadsheetApp.getActive();

  const lap = getOrCreate_(ss, SHEET.LAPORAN);
  if (lap.getLastRow() === 0) {
    lap.appendRow(HEADERS);
    lap.setFrozenRows(1);
    lap.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#1f6f43').setFontColor('#ffffff');
  }

  const master = getOrCreate_(ss, SHEET.MASTER);
  if (master.getLastRow() === 0) {
    const keys = Object.keys(DEFAULT_MASTER);
    const maxLen = Math.max.apply(null, keys.map((k) => DEFAULT_MASTER[k].length));
    const rows = [keys];
    for (let i = 0; i < maxLen; i++) rows.push(keys.map((k) => DEFAULT_MASTER[k][i] || ''));
    master.getRange(1, 1, rows.length, keys.length).setValues(rows);
    master.setFrozenRows(1);
    master.getRange(1, 1, 1, keys.length).setFontWeight('bold');
  }

  const cfg = getOrCreate_(ss, SHEET.CONFIG);
  if (cfg.getLastRow() === 0) {
    cfg.getRange(1, 1, 1, 3).setValues([['Kunci', 'Nilai', 'Keterangan']]).setFontWeight('bold');
    cfg.getRange(2, 1, DEFAULT_CONFIG.length, 3).setValues(DEFAULT_CONFIG);
    cfg.setFrozenRows(1);
  }

  const log = getOrCreate_(ss, SHEET.LOG);
  if (log.getLastRow() === 0) {
    log.appendRow(['Waktu', 'Pengguna', 'Aksi', 'ID', 'Detail']);
    log.setFrozenRows(1);
    log.getRange(1, 1, 1, 5).setFontWeight('bold');
  }

  const def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
  return 'Setup selesai.';
}

/** Mengisi contoh data agar dashboard langsung terlihat hidup. */
function seedDemoData(count) {
  ensureSetup_();
  count = count || 80;
  const master = getMaster_();
  const center = parseCenter_(getConfig_().MAP_CENTER);
  const names = ['Andi', 'Budi', 'Citra', 'Dewi', 'Eko', 'Fajar', 'Gita', 'Hendra', 'Indah', 'Joko'];
  const places = ['Jl. Merdeka', 'Jl. Sudirman', 'Pasar Lama', 'Perumahan Asri', 'Kantor Desa', 'Sekolah Dasar', 'Puskesmas', 'Terminal'];
  const sh = sheet_(SHEET.LAPORAN);
  const now = Date.now();
  const rows = [];

  for (let i = 0; i < count; i++) {
    const reported = new Date(now - Math.random() * 30 * 864e5);
    const age = (now - reported.getTime()) / 36e5;
    let status = STATUS.SELESAI;
    if (age < 6) status = STATUS.BARU;
    else if (age < 30) status = Math.random() < 0.6 ? STATUS.PROSES : STATUS.SELESAI;
    else if (Math.random() < 0.05) status = STATUS.BATAL;

    const start = status !== STATUS.BARU ? new Date(reported.getTime() + (0.2 + Math.random() * 3) * 36e5) : '';
    const done = status === STATUS.SELESAI ? new Date(start.getTime() + (0.5 + Math.random() * 30) * 36e5) : '';
    const r = Object.assign(emptyReport_(), {
      id: 'LG-' + Utilities.formatDate(reported, Session.getScriptTimeZone(), 'yyyyMMdd') + '-' + ('000' + (i + 1)).slice(-4),
      tanggalLapor: reported,
      pelapor: pick_(names),
      kontak: '08' + Math.floor(1e9 + Math.random() * 9e9),
      kategori: pick_(master.Kategori),
      prioritas: pick_(master.Prioritas),
      wilayah: pick_(master.Wilayah),
      lokasi: pick_(places) + ' No. ' + (1 + Math.floor(Math.random() * 120)),
      lat: (center[0] + (Math.random() - 0.5) * 0.14).toFixed(5),
      lng: (center[1] - 0.04 + (Math.random() - 0.5) * 0.09).toFixed(5),
      deskripsi: 'Contoh laporan gangguan (data demo).',
      status: status,
      petugas: status === STATUS.BARU ? '' : pick_(master.Petugas),
      tanggalMulai: start,
      tanggalSelesai: done,
      diperbarui: done || start || reported,
    });
    rows.push(toRow_(r));
  }
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
  log_('SEED', '', count + ' data demo');
  return count + ' data demo ditambahkan.';
}

/** Menghapus semua laporan (header tetap). */
function clearAllReports() {
  const sh = sheet_(SHEET.LAPORAN);
  if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  log_('CLEAR', '', 'Semua laporan dihapus');
}

/* ------------------------------------------------------------------ */
/* Helper                                                              */
/* ------------------------------------------------------------------ */

function ensureSetup_() {
  if (!SpreadsheetApp.getActive().getSheetByName(SHEET.LAPORAN)) setup();
}

function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" belum ada. Jalankan setup() terlebih dahulu.');
  return sh;
}

function getOrCreate_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function getConfig_() {
  const out = {};
  DEFAULT_CONFIG.forEach((r) => (out[r[0]] = r[1]));
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.CONFIG);
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach((r) => {
      if (r[0]) out[String(r[0]).trim()] = String(r[1]).trim();
    });
  }
  return out;
}

function getMaster_() {
  const out = JSON.parse(JSON.stringify(DEFAULT_MASTER));
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.MASTER);
  if (sh && sh.getLastRow() > 1) {
    const values = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
    values[0].forEach((key, c) => {
      if (!key) return;
      const list = values.slice(1).map((r) => String(r[c]).trim()).filter(String);
      if (list.length) out[key] = list;
    });
  }
  return out;
}

function getReports_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.LAPORAN);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, HEADERS.length).getValues()
    .filter((r) => r[0])
    .map((r) => serialize_(fromRow_(r)));
}

function emptyReport_() {
  const r = {};
  FIELD_KEYS.forEach((k) => (r[k] = ''));
  return r;
}

function toRow_(r) {
  return FIELD_KEYS.map((k) => (r[k] === undefined || r[k] === null ? '' : r[k]));
}

function fromRow_(row) {
  const r = {};
  FIELD_KEYS.forEach((k, i) => (r[k] = row[i]));
  return r;
}

function serialize_(r) {
  const out = {};
  FIELD_KEYS.forEach((k) => {
    const v = r[k];
    out[k] = v instanceof Date ? v.toISOString() : v === null || v === undefined ? '' : String(v);
  });
  return out;
}

const EDITABLE = ['tanggalLapor', 'pelapor', 'kontak', 'kategori', 'prioritas', 'wilayah', 'lokasi', 'lat', 'lng', 'deskripsi', 'status', 'petugas', 'catatan'];

function sanitize_(input) {
  const out = {};
  EDITABLE.forEach((k) => {
    if (input[k] === undefined) return;
    let v = String(input[k]).trim().slice(0, 2000);
    if (/^[=+\-@]/.test(v) && k !== 'lat' && k !== 'lng') v = "'" + v; // cegah formula injection
    out[k] = v;
  });
  return out;
}

function nextId_(sh, date) {
  const prefix = 'LG-' + Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyyMMdd') + '-';
  let max = 0;
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach((r) => {
      const id = String(r[0]);
      if (id.indexOf(prefix) === 0) max = Math.max(max, parseInt(id.slice(prefix.length), 10) || 0);
    });
  }
  return prefix + ('000' + (max + 1)).slice(-4);
}

function findRow_(sh, id) {
  if (sh.getLastRow() < 2) return -1;
  const ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return -1;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function log_(action, id, detail) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.LOG);
  if (sh) sh.appendRow([new Date(), currentEmail_() || '-', action, id, detail]);
}

function currentEmail_() {
  try {
    return Session.getActiveUser().getEmail() || '';
  } catch (e) {
    return '';
  }
}

function isAdmin_() {
  const list = String(getConfig_().ADMIN_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(String);
  if (!list.length) return true;
  return list.indexOf(currentEmail_().toLowerCase()) >= 0;
}

function parseCenter_(text) {
  const p = String(text || '').split(',').map(Number);
  return p.length === 2 && !isNaN(p[0]) && !isNaN(p[1]) ? p : [-2.1316, 106.1169];
}

function pick_(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
