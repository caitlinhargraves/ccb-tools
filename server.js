const express = require('express');
const cron = require('node-cron');
const path = require('path');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');
const multer = require('multer');
const FormData = require('form-data');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const MONDAY_API_KEY = process.env.MONDAY_API_KEY || 'eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjY0OTQ0NjE4NywiYWFpIjoxMSwidWlkIjoxMDE3MTA4NjgsImlhZCI6IjIwMjYtMDQtMjNUMTU6Mzc6MTkuMDAwWiIsInBlciI6Im1lOndyaXRlIiwiYWN0aWQiOjM0NDk0MDk3LCJyZ24iOiJ1c2UxIn0.6FPYgwwTj-05GWXHxxq5lSstcJTGfVOqATNhk5FQBic';
const ORDERS_BOARD_ID = '18407165363';
const PRODUCTS_SUB_BOARD_ID = '18407165552';
const QUOTES_BOARD_ID = '18425958662';
const QUOTES_SUB_BOARD_ID = '18425958868';
const REP_BOARD_ID = '18425958984';
const CLIENT_NOTES_BOARD_ID = '18426058971';
const CCB_EMAIL = 'info@ccbimprint.com';
const pricing = require('./pricing-engine');
const cryptoAuth = require('crypto');

function hashRepPassword(pw) {
  return cryptoAuth.createHash('sha256').update(String(pw) + ':ccb-rep-auth').digest('hex');
}

const FormDataNode = require('form-data');
const DEPT_LABEL_TO_ID = { 'Embroidery': 1, 'Screenprint': 2, 'DTG': 3, 'DTF': 4, 'UV Print': 8, 'Engrave': 5, 'Other': 6, 'Custom Box': 9 };

async function mondayQuery(query) {
  const r = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY, 'API-Version': '2024-01' },
    body: JSON.stringify({ query })
  });
  return r.json();
}

// Fetches every item on a board regardless of count -- items_page caps at 500 per
// call, so this follows cursor pagination until Monday reports no more pages.
// Used anywhere "all orders" or "all quotes" needs to mean ALL, not just the first 500.
async function fetchAllItems(boardId, itemsFragment) {
  let allItems = [];
  let cursor = null;
  do {
    const pageArg = cursor ? `cursor: ${JSON.stringify(cursor)}` : 'limit: 500';
    const query = `{boards(ids:[${boardId}]){items_page(${pageArg}){cursor items{${itemsFragment}}}}}`;
    const data = await mondayQuery(query);
    const page = data.data?.boards?.[0]?.items_page;
    if (!page) break;
    allItems = allItems.concat(page.items || []);
    cursor = page.cursor;
  } while (cursor);
  return allItems;
}

// Copies a file from one item's file column to another item's file column
// (download the asset bytes, re-upload -- Monday has no native "copy" mutation).
async function copyFileColumn(sourceItemId, sourceColumnId, targetItemId, targetColumnId) {
  try {
    const valQuery = `{items(ids:[${sourceItemId}]){column_values(ids:["${sourceColumnId}"]){value}}}`;
    const valData = await mondayQuery(valQuery);
    const rawValue = valData.data?.items?.[0]?.column_values?.[0]?.value;
    if (!rawValue) return { copied: 0 };
    const parsed = JSON.parse(rawValue);
    const files = parsed.files || [];
    if (!files.length) return { copied: 0 };

    let copied = 0;
    for (const f of files) {
      const assetId = f.assetId;
      if (!assetId) continue;
      const assetQuery = `{assets(ids:[${assetId}]){public_url name}}`;
      const assetData = await mondayQuery(assetQuery);
      const asset = assetData.data?.assets?.[0];
      if (!asset?.public_url) continue;

      const fileRes = await fetch(asset.public_url);
      if (!fileRes.ok) continue;
      const buffer = Buffer.from(await fileRes.arrayBuffer());

      const form = new FormDataNode();
      const mutation = `mutation add_file($file: File!) { add_file_to_column(item_id: ${targetItemId}, column_id: "${targetColumnId}", file: $file) { id } }`;
      form.append('query', mutation);
      form.append('variables[file]', buffer, { filename: asset.name || 'file', knownLength: buffer.length });

      const uploadRes = await fetch('https://api.monday.com/v2/file', {
        method: 'POST',
        headers: { 'Authorization': MONDAY_API_KEY, ...form.getHeaders() },
        body: form
      });
      const uploadData = await uploadRes.json();
      if (!uploadData.errors) copied++;
    }
    return { copied };
  } catch (err) {
    console.error('copyFileColumn error:', err.message);
    return { copied: 0, error: err.message };
  }
}

// ============================================================
// Email transporter -- uses env vars set in Render dashboard
// Set SMTP_USER and SMTP_PASS in Render environment variables
// SMTP_USER = your Gmail address, SMTP_PASS = Gmail App Password
// ============================================================
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  }
});

async function sendEmail(subject, html, attachments) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log('Email skipped -- SMTP_USER/SMTP_PASS not set in environment');
    return false;
  }
  try {
    await transporter.sendMail({
      from: `"CCB Tools" <${process.env.SMTP_USER}>`,
      to: CCB_EMAIL,
      subject,
      html,
      attachments: attachments || []
    });
    console.log(`Email sent: ${subject}`);
    return true;
  } catch (err) {
    console.error('Email error:', err.message);
    return false;
  }
}

// ============================================================
// Order cache
// ============================================================
let cache = { orders: [], lastUpdated: null, isLoading: false };

// ── Auth middleware ─────────────────────────────────────────────────────────
// Cookie-based: prompts once, then cookie keeps you in for 12 hours.
// No more re-prompting every time you navigate to a new page.
const crypto = require('crypto');

function makeAuthToken(user, pass) {
  return crypto.createHash('sha256').update(user + ':' + pass + ':ccb-tools').digest('hex');
}

app.use((req, res, next) => {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;

  // Skip auth if env vars not set (dev mode)
  if (!user || !pass) return next();

  // Always allow API endpoints
  if (req.path.startsWith('/api/')) return next();

  const expectedToken = makeAuthToken(user, pass);

  // Check cookie -- already authenticated this session
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const parts = c.trim().split('=');
    const k = parts.shift();
    if (k) cookies[k] = parts.join('=');
  });
  if (cookies['ccb_auth'] === expectedToken) return next();

  // Fall back to Basic Auth prompt
  const authHeader = req.headers['authorization'] || '';
  const b64 = authHeader.startsWith('Basic ') ? authHeader.slice(6) : '';
  const decoded = Buffer.from(b64, 'base64').toString();
  const colon = decoded.indexOf(':');
  const u = decoded.slice(0, colon);
  const p = decoded.slice(colon + 1);

  if (u === user && p === pass) {
    // Set cookie for 12 hours
    res.set('Set-Cookie', 'ccb_auth=' + expectedToken + '; Path=/; Max-Age=43200; HttpOnly; SameSite=Strict');
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="CCB Tools"');
  res.status(401).send('Authentication required');
});

app.use(express.static(path.join(__dirname)));
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ============================================================
// Monday fetch
// ============================================================
async function fetchFromMonday() {
  if (cache.isLoading) return;
  cache.isLoading = true;
  console.log('Fetching from Monday...', new Date().toISOString());
  try {
    const itemsFragment = `
      id name created_at updated_at
      group { id }
      column_values { id text value }
      subitems {
        id name
        column_values { id text value }
      }
    `;
    cache.orders = await fetchAllItems(ORDERS_BOARD_ID, itemsFragment);
    cache.lastUpdated = new Date().toISOString();
    console.log(`Cache updated: ${cache.orders.length} orders`);
  } catch (err) {
    console.error('Fetch error:', err);
  }
  cache.isLoading = false;
}

// ============================================================
// Weekly export -- build HTML email + CSV attachment
// ============================================================
function colText(item, colId) {
  return item.column_values?.find(c => c.id === colId)?.text || '';
}

function buildOrdersCSV(orders) {
  const active = orders.filter(o => o.group?.id === 'topics');
  const headers = ['CCB Order #','Company','Contact','Status','In Hands Date','Sales Rep','CCB Company','Invoice Status','Shipping Status','Products','Notes'];
  const rows = active.map(o => {
    const cols = {};
    for (const c of (o.column_values || [])) cols[c.id] = c.text || '';
    const productCount = (o.subitems || []).length;
    return [
      cols['pulse_id_mm27vwa5'] || '',
      o.name,
      cols['text_mm221kg3'] || '',
      cols['color_mm27qyta'] || '',
      cols['date_mm22wpk2'] || '',
      cols['dropdown_mm22w5rr'] || '',
      cols['dropdown_mm276wtz'] || '',
      cols['color_mm282b4b'] || '',
      cols['color_mm29xat9'] || '',
      productCount,
      cols['long_text_mm225vbf'] || ''
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
  });
  return [headers.join(','), ...rows].join('\n');
}

function buildWeeklyEmailHTML(orders) {
  const active = orders.filter(o => o.group?.id === 'topics');
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Stats
  const statuses = {};
  active.forEach(o => {
    const s = o.column_values?.find(c => c.id === 'color_mm27qyta')?.text || 'Unknown';
    statuses[s] = (statuses[s] || 0) + 1;
  });

  // Overdue
  const overdue = active.filter(o => {
    const ihd = o.column_values?.find(c => c.id === 'date_mm22wpk2')?.text;
    if (!ihd) return false;
    return new Date(ihd) < today;
  });

  // Build table rows
  const tableRows = active.slice(0, 100).map(o => {
    const cols = {};
    for (const c of (o.column_values || [])) cols[c.id] = c.text || '';
    const ihd = cols['date_mm22wpk2'];
    const ihdDate = ihd ? new Date(ihd) : null;
    const isOverdue = ihdDate && ihdDate < today;
    const isSoon = ihdDate && !isOverdue && (ihdDate - today) / 86400000 <= 3;
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #F3F4F6;font-weight:700;color:#00AEEF">${cols['pulse_id_mm27vwa5'] || ''}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #F3F4F6">${o.name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #F3F4F6">${cols['color_mm27qyta'] || ''}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #F3F4F6;color:${isOverdue ? '#DC2626' : isSoon ? '#D97706' : 'inherit'};font-weight:${isOverdue || isSoon ? '700' : '400'}">${ihd || '—'}${isOverdue ? ' ⚠' : ''}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #F3F4F6">${cols['dropdown_mm22w5rr'] || ''}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #F3F4F6">${(o.subitems || []).length} items</td>
      <td style="padding:8px 12px;border-bottom:1px solid #F3F4F6">${cols['color_mm282b4b'] || ''}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <style>body{font-family:'Helvetica Neue',Arial,sans-serif;color:#1B2A4A;background:#E8EBF4;margin:0;padding:20px;}
  .wrap{max-width:900px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(27,42,74,.1);}
  .header{background:#1B2A4A;padding:28px 32px;color:#fff;}
  .header h1{margin:0;font-size:22px;font-weight:800;}
  .header p{margin:6px 0 0;font-size:13px;opacity:.7;}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1px;background:#E8EBF4;}
  .stat{background:#fff;padding:16px 20px;text-align:center;}
  .stat-num{font-size:28px;font-weight:800;color:#1B2A4A;}
  .stat-lbl{font-size:11px;color:#6B7280;margin-top:2px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;}
  .section{padding:24px 32px;}
  .section h2{font-size:14px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#6B7280;margin:0 0 14px;}
  table{width:100%;border-collapse:collapse;font-size:13px;}
  th{padding:8px 12px;text-align:left;background:#F8FAFF;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#9CA3AF;border-bottom:2px solid #E5E7EB;}
  .footer{padding:20px 32px;background:#F8FAFF;border-top:1px solid #E5E7EB;font-size:12px;color:#9CA3AF;text-align:center;}
  .overdue-banner{background:#FEF2F2;border-left:4px solid #DC2626;padding:12px 20px;margin:0 32px 20px;border-radius:0 8px 8px 0;font-size:13px;color:#DC2626;font-weight:600;}
  </style></head><body><div class="wrap">
  <div class="header">
    <h1>📋 CCB Orders — Weekly Backup</h1>
    <p>${dateStr} · ${active.length} Active Orders</p>
  </div>
  ${overdue.length ? `<div class="overdue-banner">⚠ ${overdue.length} order${overdue.length !== 1 ? 's' : ''} with overdue in-hands date — review needed</div>` : ''}
  <div class="stats">
    ${Object.entries(statuses).map(([s, n]) => `<div class="stat"><div class="stat-num">${n}</div><div class="stat-lbl">${s}</div></div>`).join('')}
  </div>
  <div class="section">
    <h2>Active Orders</h2>
    <table>
      <thead><tr>
        <th>CCB #</th><th>Company</th><th>Status</th><th>In Hands</th><th>Sales Rep</th><th>Products</th><th>Invoice</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
  </div>
  <div class="footer">
    This is an automated weekly backup from CCB Tools · ${new Date().toISOString()}<br>
    Full CSV attached · ccb-api-jorp.onrender.com
  </div>
  </div></body></html>`;
}

async function sendWeeklyExport() {
  if (!cache.orders.length) await fetchFromMonday();
  const csv = buildOrdersCSV(cache.orders);
  const html = buildWeeklyEmailHTML(cache.orders);
  const date = new Date().toISOString().split('T')[0];
  await sendEmail(
    `CCB Orders Weekly Backup — ${date}`,
    html,
    [{ filename: `ccb-orders-${date}.csv`, content: csv }]
  );
}

// ============================================================
// Low stock alert
// ============================================================
async function sendLowStockAlert(alerts) {
  if (!alerts.length) return;
  const rows = alerts.map(a =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #F3F4F6;font-weight:600">${a.name}</td>
     <td style="padding:8px 12px;border-bottom:1px solid #F3F4F6">${a.category}</td>
     <td style="padding:8px 12px;border-bottom:1px solid #F3F4F6;color:${a.qty === 0 ? '#DC2626' : '#D97706'};font-weight:700">${a.qty === 0 ? 'OUT OF STOCK' : `Low (${a.qty} ${a.unit || 'units'})`}</td>
     <td style="padding:8px 12px;border-bottom:1px solid #F3F4F6">${a.reorderPoint || '—'}</td>
     <td style="padding:8px 12px;border-bottom:1px solid #F3F4F6">${a.supplier || '—'}</td></tr>`
  ).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <style>body{font-family:'Helvetica Neue',Arial,sans-serif;color:#1B2A4A;background:#E8EBF4;margin:0;padding:20px;}
  .wrap{max-width:700px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;}
  .header{background:#D97706;padding:20px 24px;color:#fff;}
  .header h1{margin:0;font-size:18px;font-weight:800;}
  table{width:100%;border-collapse:collapse;font-size:13px;}
  th{padding:8px 12px;text-align:left;background:#FFFBEB;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#D97706;border-bottom:2px solid #FCD34D;}
  .footer{padding:16px 24px;background:#FFF9F0;border-top:1px solid #FCD34D;font-size:12px;color:#9CA3AF;}
  </style></head><body><div class="wrap">
  <div class="header"><h1>⚠ CCB Inventory Alert — Low Stock Items</h1><p style="margin:4px 0 0;font-size:12px;opacity:.8">${new Date().toLocaleDateString('en-US', {weekday:'long',year:'numeric',month:'long',day:'numeric'})}</p></div>
  <table><thead><tr><th>Item</th><th>Category</th><th>Status</th><th>Reorder At</th><th>Supplier</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <div class="footer">Update inventory at ccb-api-jorp.onrender.com/inventory.html</div>
  </div></body></html>`;

  await sendEmail(`⚠ CCB Inventory Alert — ${alerts.length} item${alerts.length !== 1 ? 's' : ''} low/out`, html);
}

// ============================================================
// File-based inventory store -- persists across sleep cycles
// Stored at /tmp/ccb_inventory.json on Render
// ============================================================
const INVENTORY_FILE = process.env.INVENTORY_FILE || '/tmp/ccb_inventory.json';
const fs = require('fs');

function loadInventoryFromDisk() {
  try {
    if (fs.existsSync(INVENTORY_FILE)) {
      const raw = fs.readFileSync(INVENTORY_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      console.log(`Inventory loaded from disk: ${(parsed.items||[]).length} items, ${(parsed.threadColors||[]).length} thread colors`);
      return parsed;
    }
  } catch(e) {
    console.error('Failed to load inventory from disk:', e.message);
  }
  return {
    categories: ['Production Supplies', 'Ink', 'Embroidery', 'Office Supplies', 'Birthday Gifts', 'Standard Gift Boxes', 'Thread'],
    items: [],
    threadColors: []
  };
}

function saveInventoryToDisk(data) {
  try {
    fs.writeFileSync(INVENTORY_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch(e) {
    console.error('Failed to save inventory to disk:', e.message);
    return false;
  }
}

let inventoryStore = loadInventoryFromDisk();

// ============================================================
// API endpoints
// ============================================================

app.get('/api/orders', (req, res) => {
  res.json({ orders: cache.orders, lastUpdated: cache.lastUpdated, count: cache.orders.length });
});

app.get('/api/refresh', async (req, res) => {
  await fetchFromMonday();
  res.json({ success: true, lastUpdated: cache.lastUpdated, count: cache.orders.length });
});

// Inventory endpoints
app.get('/api/inventory', (req, res) => {
  // Reload from disk on each request to ensure freshness
  inventoryStore = loadInventoryFromDisk();
  res.json(inventoryStore);
});

app.post('/api/inventory', (req, res) => {
  const { categories, items, threadColors } = req.body;
  if (categories) inventoryStore.categories = categories;
  if (items) inventoryStore.items = items;
  if (threadColors) inventoryStore.threadColors = threadColors;
  // Save to disk immediately
  const saved = saveInventoryToDisk(inventoryStore);
  if (!saved) console.error('Warning: inventory save to disk failed');

  // Check for low stock and batch for 8am alert
  const lowItems = (inventoryStore.items || []).filter(item => {
    if (!item.reorderPoint) return false;
    return (parseFloat(item.qty) || 0) <= parseFloat(item.reorderPoint);
  });
  const outOfStock = (inventoryStore.threadColors || []).filter(t => t.status === 'Out');

  // Store pending alerts -- sent at 8am via cron
  inventoryStore._pendingAlerts = [
    ...lowItems.map(i => ({ name: i.name, category: i.category, qty: parseFloat(i.qty) || 0, unit: i.unit, reorderPoint: i.reorderPoint, supplier: i.supplier })),
    ...outOfStock.map(t => ({ name: `Thread: ${t.name}`, category: 'Thread', qty: 0, reorderPoint: null, supplier: null }))
  ];

  res.json({ success: true });
});

app.post('/api/inventory/send-alert', async (req, res) => {
  const alerts = inventoryStore._pendingAlerts || [];
  if (alerts.length) {
    await sendLowStockAlert(alerts);
    inventoryStore._pendingAlerts = [];
  }
  res.json({ success: true, alertsSent: alerts.length });
});

// Gift Boxes from Monday
app.get('/api/gift-boxes', async (req, res) => {
  try {
    const query = `{boards(ids:[18409662777]){items_page(limit:100){items{id name column_values{id text value}subitems{id name}}}}}`;
    const r = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY, 'API-Version': '2024-01' },
      body: JSON.stringify({ query })
    });
    const d = await r.json();
    res.json({ boxes: d.data?.boards[0]?.items_page?.items || [] });
  } catch (err) {
    res.json({ boxes: [], error: err.message });
  }
});

// ============================================================
// Monday API proxy -- all HTML files call this instead of
// hitting Monday directly, so the API key lives only here
// ============================================================
app.post('/api/monday', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Missing query' });
    const r = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': MONDAY_API_KEY,
        'API-Version': '2024-01'
      },
      body: JSON.stringify({ query })
    });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// File upload relay -- browser sends file here, we relay to
// Monday's file API (can't do this from browser due to CORS)
// POST /api/upload-file  multipart: file, itemId, columnId
// ============================================================
app.post('/api/upload-file', upload.single('file'), async (req, res) => {
  try {
    const { itemId, columnId } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    if (!itemId || !columnId) return res.status(400).json({ error: 'itemId and columnId required' });

    // Normalize MIME type — browsers often send empty string for .ai / .eps files
    const ext = (req.file.originalname.split('.').pop() || '').toLowerCase();
    const mimeOverrides = { ai: 'application/postscript', eps: 'application/postscript', svg: 'image/svg+xml' };
    const contentType = req.file.mimetype || mimeOverrides[ext] || 'application/octet-stream';

    const form = new FormData();
    const query = `mutation add_file($file: File!) { add_file_to_column(item_id: ${itemId}, column_id: "${columnId}", file: $file) { id } }`;
    form.append('query', query);
    form.append('variables[file]', req.file.buffer, {
      filename: req.file.originalname,
      contentType,
      knownLength: req.file.size
    });

    const r = await fetch('https://api.monday.com/v2/file', {
      method: 'POST',
      headers: {
        'Authorization': MONDAY_API_KEY,
        'API-Version': '2024-01',
        ...form.getHeaders()
      },
      body: form
    });
    const data = await r.json();
    if (data.errors) return res.status(400).json({ error: data.errors[0].message, details: data.errors });
    res.json({ success: true, data });
  } catch (err) {
    console.error('File upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CCB Order Number generator
// Reads all existing CCB-##### numbers and returns next one
// ============================================================
app.get('/api/next-order-number', async (req, res) => {
  try {
    const items = await fetchAllItems(ORDERS_BOARD_ID, 'column_values(ids:["text_mm29djkk"]){id text}');
    let max = 116; // start from CCB-00117
    for (const item of items) {
      const txt = item.column_values?.find(c => c.id === 'text_mm29djkk')?.text || '';
      const match = txt.match(/CCB-(\d+)/);
      if (match) {
        const n = parseInt(match[1], 10);
        if (n > max) max = n;
      }
    }
    const next = `CCB-${String(max + 1).padStart(5, '0')}`;
    res.json({ orderNumber: next });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual weekly export trigger (for testing)
app.post('/api/send-weekly-export', async (req, res) => {
  try {
    await sendWeeklyExport();
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ============================================================
// Cron jobs
// ============================================================

// Monday data refresh: 4am-8pm CT every minute
cron.schedule('* 10-23 * * *', fetchFromMonday);
cron.schedule('* 0-2 * * *', fetchFromMonday);

// Weekly export: every Monday at 8am CT (2pm UTC)
cron.schedule('0 14 * * 1', () => {
  console.log('Running weekly export...');
  sendWeeklyExport().catch(console.error);
});

// Daily low stock alerts: 8am CT weekdays (2pm UTC Mon-Fri)
cron.schedule('0 14 * * 1-5', async () => {
  const alerts = inventoryStore._pendingAlerts || [];
  if (alerts.length) {
    console.log(`Sending ${alerts.length} low stock alerts...`);
    await sendLowStockAlert(alerts).catch(console.error);
    inventoryStore._pendingAlerts = [];
  }
});

// Initial fetch on startup
fetchFromMonday();

// ── FILE PROXY -- serves Monday protected_static files with auth ──────────────
// Usage: /api/file-proxy?assetId=12345
// Fetches the signed public_url from Monday assets API then streams the file back
app.get('/api/file-proxy', async (req, res) => {
  const { assetId } = req.query;
  if (!assetId) return res.status(400).json({ error: 'assetId required' });
  try {
    // Get signed URL from Monday assets API
    const q = `{assets(ids:[${assetId}]){id name public_url url_thumbnail}}`;
    const apiRes = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY, 'API-Version': '2024-01' },
      body: JSON.stringify({ query: q })
    });
    const data = await apiRes.json();
    const asset = data?.data?.assets?.[0];
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    // Use public_url but strip the content-disposition so it renders inline
    const signedUrl = asset.public_url;
    const fileRes = await fetch(signedUrl);
    if (!fileRes.ok) return res.status(fileRes.status).send('Failed to fetch asset');

    // Forward content-type, remove attachment disposition
    const ct = fileRes.headers.get('content-type') || 'application/octet-stream';
    const fname = asset.name || 'file';
    res.set('Content-Type', ct);
    res.set('Content-Disposition', `inline; filename="${fname}"`);
    res.set('Cache-Control', 'private, max-age=3300'); // cache ~55min (URL expires in 60)
    fileRes.body.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ============================================================
// POST /api/download-zip
// Body: { assetIds: [id, id, ...], filename: 'CCB-00123-artwork.zip' }
// Fetches all assets from Monday, streams them into a zip, returns it
// ============================================================
app.post('/api/download-zip', async (req, res) => {
  const { assetIds, filename } = req.body;
  if (!assetIds || !assetIds.length) return res.status(400).json({ error: 'assetIds required' });

  try {
    // Fetch all asset metadata in one query
    const q = `{assets(ids:[${assetIds.join(',')}]){id name public_url}}`;
    const apiRes = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY, 'API-Version': '2024-01' },
      body: JSON.stringify({ query: q })
    });
    const data = await apiRes.json();
    const assets = data?.data?.assets || [];
    if (!assets.length) return res.status(404).json({ error: 'No assets found' });

    const zipName = filename || 'artwork.zip';
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${zipName}"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', err => { console.error('Archiver error:', err); });
    archive.pipe(res);

    // Fetch each file and append to zip, deduplicating names
    const usedNames = {};
    for (const asset of assets) {
      const fileRes = await fetch(asset.public_url);
      if (!fileRes.ok) continue;
      // Deduplicate filenames
      let name = asset.name || `file_${asset.id}`;
      if (usedNames[name]) {
        const dot = name.lastIndexOf('.');
        const base = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        name = `${base}_${usedNames[name]}${ext}`;
      }
      usedNames[asset.name || `file_${asset.id}`] = (usedNames[asset.name || `file_${asset.id}`] || 1) + 1;
      archive.append(fileRes.body, { name });
    }

    await archive.finalize();
  } catch (err) {
    console.error('Zip error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});


// ============================================================
// REP AUTH -- password-gated pages, no separate Monday seats.
// Rep Access board (REP_BOARD_ID) stores: Role, Password Hash,
// Sales Person Match, Active.
// ============================================================
app.post('/api/rep/login', async (req, res) => {
  try {
    const { password, selectedRep } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required' });
    if (!selectedRep) return res.status(400).json({ error: 'Select who you are first' });
    const hash = hashRepPassword(password);
    const query = `{boards(ids:[${REP_BOARD_ID}]){items_page(limit:100){items{id name column_values{id text value}}}}}`;
    const data = await mondayQuery(query);
    const items = data.data?.boards?.[0]?.items_page?.items || [];
    for (const item of items) {
      const cv = {};
      item.column_values.forEach(c => cv[c.id] = c.text);
      const role = cv['color_mm63fnqv'] || 'Sales Rep';
      const salesPerson = cv['text_mm6380j8'] || '';
      const isMatch = role === 'Admin' ? selectedRep === 'Admin' : salesPerson === selectedRep;
      if (isMatch && cv['text_mm63mwrn'] === hash && cv['color_mm635y4q'] === 'Active') {
        return res.json({ ok: true, repId: item.id, name: item.name, role, salesPerson });
      }
    }
    res.json({ ok: false, error: 'That password does not match the selected rep.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rep/signup', async (req, res) => {
  try {
    const { name, salesPerson, password } = req.body;
    if (!name || !salesPerson || !password) return res.status(400).json({ error: 'name, salesPerson, and password required' });
    if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

    // Prevent duplicate self-signup for the same sales person
    const checkQuery = `{boards(ids:[${REP_BOARD_ID}]){items_page(limit:100){items{id column_values(ids:["text_mm6380j8"]){text}}}}}`;
    const checkData = await mondayQuery(checkQuery);
    const existing = (checkData.data?.boards?.[0]?.items_page?.items || [])
      .some(i => (i.column_values?.[0]?.text || '').toLowerCase() === salesPerson.toLowerCase());
    if (existing) return res.status(400).json({ error: `${salesPerson} already has a password set. Use the login screen, or ask an admin to reset it.` });

    const hash = hashRepPassword(password);
    const today = new Date().toISOString().slice(0, 10);
    const cv = JSON.stringify({
      'color_mm63fnqv': { label: 'Sales Rep' },
      'text_mm63mwrn': hash,
      'text_mm6380j8': salesPerson,
      'color_mm635y4q': { label: 'Active' },
      'date_mm63ed4m': { date: today }
    });
    const mutation = `mutation { create_item(board_id: ${REP_BOARD_ID}, item_name: ${JSON.stringify(name)}, column_values: ${JSON.stringify(cv)}) { id } }`;
    const result = await mondayQuery(mutation);
    if (result.errors) return res.status(400).json({ error: result.errors[0].message });
    res.json({ ok: true, repId: result.data.create_item.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// QUOTES -- client history lookup (drives commission tier)
// ============================================================
app.get('/api/quote/client-history', async (req, res) => {
  try {
    const client = (req.query.client || '').trim();
    if (!client) return res.json({ orderCount: 0, rolling12moRevenue: 0 });

    const items = await fetchAllItems(ORDERS_BOARD_ID, 'id name column_values(ids:["date4","numeric_mm4wv7sc"]){id text}');
    const now = Date.now();
    const yearMs = 365 * 24 * 60 * 60 * 1000;

    let orderCount = 0;
    let rolling12moRevenue = 0;
    for (const item of items) {
      if ((item.name || '').trim().toLowerCase() !== client.toLowerCase()) continue;
      orderCount++;
      const dateStr = item.column_values.find(c => c.id === 'date4')?.text;
      const revStr = item.column_values.find(c => c.id === 'numeric_mm4wv7sc')?.text;
      const rev = parseFloat(revStr) || 0;
      if (dateStr) {
        const orderDate = new Date(dateStr).getTime();
        if (!isNaN(orderDate) && (now - orderDate) <= yearMs) rolling12moRevenue += rev;
      }
    }
    const commission = pricing.computeCommissionRate(orderCount, rolling12moRevenue);
    res.json({ orderCount, rolling12moRevenue, commissionRate: commission.rate, commissionTier: commission.tier });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// QUOTES -- live pricing preview (no Monday writes)
// body: { quoteType: 'Garment/Decoration'|'Custom Box', lines: [...] }
// ============================================================
app.post('/api/quote/price-preview', (req, res) => {
  try {
    const { quoteType, lines } = req.body;
    const results = (lines || []).map(line => {
      if (quoteType === 'Custom Box') return pricing.computeBoxLine(line);
      return pricing.computeGarmentLine(line);
    });
    const totalRevenue = results.reduce((s, r) => s + (r.totalRevenue || 0), 0);
    const totalCost = results.reduce((s, r) => s + (r.totalCost || 0), 0);
    const grossProfit = totalRevenue - totalCost;
    res.json({ lines: results, totals: { totalRevenue, totalCost, grossProfit } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// QUOTES -- save (create or update quote + line item subitems)
// ============================================================
app.post('/api/quote/save', async (req, res) => {
  try {
    const {
      quoteId, client, contact, email, phone, salesPerson,
      quoteType, orderType, notes, lines
    } = req.body;
    if (!client) return res.status(400).json({ error: 'Client name required' });

    // Pricing + commission
    const computed = (lines || []).map(line =>
      quoteType === 'Custom Box' ? pricing.computeBoxLine(line) : pricing.computeGarmentLine(line)
    );
    const totalRevenue = computed.reduce((s, r) => s + (r.totalRevenue || 0), 0);
    const totalCost = computed.reduce((s, r) => s + (r.totalCost || 0), 0);
    const grossProfit = totalRevenue - totalCost;
    const marginPct = totalRevenue > 0 ? grossProfit / totalRevenue : 0;

    const items = await fetchAllItems(ORDERS_BOARD_ID, 'id name column_values(ids:["date4","numeric_mm4wv7sc"]){id text}');
    const now = Date.now(); const yearMs = 365 * 24 * 60 * 60 * 1000;
    let orderCount = 0, rolling12moRevenue = 0;
    for (const item of items) {
      if ((item.name || '').trim().toLowerCase() !== client.trim().toLowerCase()) continue;
      orderCount++;
      const dateStr = item.column_values.find(c => c.id === 'date4')?.text;
      const rev = parseFloat(item.column_values.find(c => c.id === 'numeric_mm4wv7sc')?.text) || 0;
      if (dateStr) { const d = new Date(dateStr).getTime(); if (!isNaN(d) && (now - d) <= yearMs) rolling12moRevenue += rev; }
    }
    const commission = pricing.computeCommissionRate(orderCount, rolling12moRevenue);
    const commissionAmount = grossProfit * commission.rate;

    const today = new Date().toISOString().slice(0, 10);
    const quoteCV = {
      'dropdown_mm63w1e': { labels: [salesPerson] },
      'text_mm639ee3': contact || '',
      'email_mm63ex5f': email ? { email: email, text: email } : '',
      'phone_mm635egd': phone || '',
      'color_mm63gx38': { label: quoteType || 'Garment/Decoration' },
      'color_mm639bpf': { label: orderType || 'New Order' },
      'numeric_mm63tz48': orderCount + 1,
      'numeric_mm63xaq7': Math.round(rolling12moRevenue * 100) / 100,
      'numeric_mm63k849': commission.rate,
      'numeric_mm63wrys': Math.round(totalRevenue * 100) / 100,
      'numeric_mm63d3v6': Math.round(totalCost * 100) / 100,
      'numeric_mm63wxbd': Math.round(grossProfit * 100) / 100,
      'numeric_mm6381qx': Math.round(commissionAmount * 100) / 100,
      'numeric_mm63jvbw': Math.round(marginPct * 10000) / 100,
      'date_mm63wc7v': { date: today },
      'long_text_mm63bzx4': notes || '',
    };
    if (!quoteId) quoteCV['color_mm63qxwk'] = { label: 'Draft' };

    let finalQuoteId = quoteId;
    if (quoteId) {
      const mutation = `mutation { change_multiple_column_values(item_id: ${quoteId}, board_id: ${QUOTES_BOARD_ID}, column_values: ${JSON.stringify(JSON.stringify(quoteCV))}, create_labels_if_missing: true) { id } }`;
      const result = await mondayQuery(mutation);
      if (result.errors) return res.status(400).json({ error: result.errors[0].message });
    } else {
      const mutation = `mutation { create_item(board_id: ${QUOTES_BOARD_ID}, group_id: "topics", item_name: ${JSON.stringify(client)}, column_values: ${JSON.stringify(JSON.stringify(quoteCV))}, create_labels_if_missing: true) { id } }`;
      const result = await mondayQuery(mutation);
      if (result.errors) return res.status(400).json({ error: result.errors[0].message });
      finalQuoteId = result.data.create_item.id;
    }

    // Remove existing subitems if updating, then recreate fresh (simplest way to keep line items in sync)
    if (quoteId) {
      const subQuery = `{items(ids:[${quoteId}]){subitems{id}}}`;
      const subData = await mondayQuery(subQuery);
      const existingSubs = subData.data?.items?.[0]?.subitems || [];
      for (const s of existingSubs) {
        await mondayQuery(`mutation { delete_item(item_id: ${s.id}) { id } }`);
      }
    }

    const createdSubitemIds = [];
    for (let i = 0; i < (lines || []).length; i++) {
      const line = lines[i];
      const calc = computed[i];
      const lineName = line.productName || `Product ${i + 1}`;
      const subCV = {
        'numeric_mm63dqd9': line.quantity || 0,
        'numeric_mm63e2t8': line.sellPricePerUnit || 0,
        'text_mm64r1ka': line.styleSku || '',
        'text_mm63pdpj': line.artworkDescription || '',
        'long_text_mm6365bn': line.notes || '',
      };
      if (quoteType === 'Custom Box') {
        subCV['numeric_mm63p5ha'] = line.setupCostPerUnit || 0; // repurposed field for box setup cost
      } else {
        subCV['numeric_mm63p5ha'] = line.garmentCostPerUnit || 0;
        subCV['numeric_mm63wt0j'] = line.screensRegular || 0;
        subCV['numeric_mm63fc9y'] = line.screensLarge || 0;
        subCV['numeric_mm638g7h'] = line.rushFeeFlat || 0;
        subCV['numeric_mm63v7rq'] = line.artHours || 0;
        const decos = line.decorations || [];
        const deptCols = ['dropdown_mm64kdgh', 'dropdown_mm64m4m8', 'dropdown_mm64a9eh'];
        const placeCols = ['text_mm647jqe', 'text_mm64wvjr', 'text_mm64fbdj'];
        const artDescCols = ['text_mm63pdpj', 'text_mm64962g', 'text_mm64ax4a'];
        const screenCountCols = ['numeric_mm64z758', 'numeric_mm64hx1r', 'numeric_mm64v4nq'];
        const decoTypeCols = ['dropdown_mm6390a0', 'dropdown_mm63j73', 'dropdown_mm633q95'];
        const colorSizeCols = ['text_mm63crtv', 'text_mm63cqht', 'text_mm632xb7'];
        decos.slice(0, 3).forEach((d, i) => {
          if (!d || !d.type) return;
          subCV[decoTypeCols[i]] = { labels: [d.type] };
          if (d.colorOrSize) subCV[colorSizeCols[i]] = d.colorOrSize;
          if (d.department) subCV[deptCols[i]] = { labels: [d.department] };
          if (d.placement) subCV[placeCols[i]] = d.placement;
          if (d.artworkDescription) subCV[artDescCols[i]] = d.artworkDescription;
          if (d.screenCount) subCV[screenCountCols[i]] = Number(d.screenCount) || 0;
        });
      }
      subCV['numeric_mm63mz1e'] = Math.round(((calc.decoCostPerUnit || 0) + (calc.overheadPerUnit || 0)) * 100) / 100;
      subCV['numeric_mm63hz7j'] = calc.minFloor != null ? Math.round(calc.minFloor * 100) / 100 : 0;
      subCV['numeric_mm6311md'] = Math.round((calc.totalRevenue || 0) * 100) / 100;
      subCV['numeric_mm63svmk'] = Math.round((calc.totalCost || 0) * 100) / 100;
      subCV['numeric_mm6314ad'] = Math.round((calc.grossProfit || 0) * 100) / 100;

      const subMutation = `mutation { create_subitem(parent_item_id: ${finalQuoteId}, item_name: ${JSON.stringify(lineName)}, column_values: ${JSON.stringify(JSON.stringify(subCV))}, create_labels_if_missing: true) { id } }`;
      const subResult = await mondayQuery(subMutation);
      if (subResult.errors) console.error('Subitem create error:', subResult.errors);
      createdSubitemIds.push(subResult.data?.create_subitem?.id || null);
    }

    res.json({
      ok: true, quoteId: finalQuoteId, subitemIds: createdSubitemIds,
      totals: { totalRevenue, totalCost, grossProfit, commissionRate: commission.rate, commissionAmount, tier: commission.tier }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// QUOTES -- list (for quote builder "my quotes" + dashboards)
// ============================================================
app.get('/api/quote/list', async (req, res) => {
  try {
    const items = await fetchAllItems(QUOTES_BOARD_ID, 'id name group{id title} column_values{id text value} subitems{id name}');
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// QUOTES -- promote to a real Order Intake item + Products
// subitems. Quote item then moves to the archive group.
// ============================================================
app.post('/api/quote/promote', async (req, res) => {
  try {
    const { quoteId } = req.body;
    if (!quoteId) return res.status(400).json({ error: 'quoteId required' });

    const query = `{items(ids:[${quoteId}]){id name column_values{id text value} subitems{id name column_values{id text value}}}}`;
    const data = await mondayQuery(query);
    const quote = data.data?.items?.[0];
    if (!quote) return res.status(404).json({ error: 'Quote not found' });
    const cv = {}; quote.column_values.forEach(c => cv[c.id] = c.text);

    const orderCV = {
      'dropdown_mm22w5rr': { labels: [cv['dropdown_mm63w1e'] || ''] },
      'date4': { date: new Date().toISOString().slice(0, 10) },
      'text_mm221kg3': cv['text_mm639ee3'] || '',
      'color_mm27qyta': { label: 'New' },
      'numeric_mm4wv7sc': parseFloat(cv['numeric_mm63wrys']) || 0,
      'numeric_mm4wyq9k': parseFloat(cv['numeric_mm63wxbd']) || 0,
      'numeric_mm4w38cv': parseFloat(cv['numeric_mm6381qx']) || 0,
      'numeric_mm64z51s': parseFloat(cv['numeric_mm63k849']) || 0,
      'boolean_mm6446x5': { checked: 'false' }, // NOT legacy -- costs were computed properly at quote time, never editable after the fact
      'long_text_mm225vbf': cv['long_text_mm63bzx4'] || '',
    };
    if (cv['email_mm63ex5f']) orderCV['email_mm22ap28'] = { email: cv['email_mm63ex5f'], text: cv['email_mm63ex5f'] };
    if (cv['phone_mm635egd']) orderCV['phone_mm22ertc'] = cv['phone_mm635egd'];
    const createOrder = `mutation { create_item(board_id: ${ORDERS_BOARD_ID}, group_id: "topics", item_name: ${JSON.stringify(quote.name)}, column_values: ${JSON.stringify(JSON.stringify(orderCV))}, create_labels_if_missing: true) { id } }`;
    const orderResult = await mondayQuery(createOrder);
    if (orderResult.errors) return res.status(400).json({ error: orderResult.errors[0].message });
    const orderItemId = orderResult.data.create_item.id;

    for (const sub of (quote.subitems || [])) {
      const scv = {}; sub.column_values.forEach(c => scv[c.id] = c.text);
      const prodCV = {
        'color_mm2dd6d5': { label: 'In House Decoration' },
        'text_mm22fv7y': scv['text_mm64r1ka'] || '', // Style # / SKU -- matches original order form's item number field
        'numeric_mm2299qw': parseFloat(scv['numeric_mm63e2t8']) || 0,
        'numeric_mm266zz9': parseFloat(scv['numeric_mm63mz1e']) || 0,
        'numeric_mm22crjt': parseFloat(scv['numeric_mm63dqd9']) || 0,
        'long_text_mm27e9c4': scv['long_text_mm6365bn'] || '',
      };

      // Production routing: which department (Embroidery/Screenprint/DTG/etc.) picks this up --
      // this is separate from the pricing "Decoration Type" used for cost lookup, and uses the
      // SAME numeric option ids the original order form writes ({ids:[N]}, not label text).
      const deptCols = [
        { dept: 'dropdown_mm64kdgh', place: 'text_mm647jqe', desc: 'text_mm63pdpj', screens: 'numeric_mm64z758', colors: 'text_mm63crtv', artFile: 'file_mm63pm92', prodDept: 'dropdown_mm2y4w39', prodPlace: 'text_mm2y6g62', prodDesc: 'text_mm2y3mb9', prodScreens: 'numeric_mm2yn2nb', prodColors: 'text_mm2y2y6a', prodArtFile: 'file_mm2y1yem' },
        { dept: 'dropdown_mm64m4m8', place: 'text_mm64wvjr', desc: 'text_mm64962g', screens: 'numeric_mm64hx1r', colors: 'text_mm63cqht', artFile: 'file_mm64b6m8', prodDept: 'dropdown_mm2yaxxz', prodPlace: 'text_mm2yge79', prodDesc: 'text_mm2ymf5k', prodScreens: 'numeric_mm2ynqby', prodColors: 'text_mm2y5vn6', prodArtFile: 'file_mm2ya55c' },
        { dept: 'dropdown_mm64a9eh', place: 'text_mm64fbdj', desc: 'text_mm64ax4a', screens: 'numeric_mm64v4nq', colors: 'text_mm632xb7', artFile: 'file_mm648efm', prodDept: 'dropdown_mm2ygyew', prodPlace: 'text_mm2y1j6j', prodDesc: 'text_mm2yjq0z', prodScreens: 'numeric_mm2y55qh', prodColors: 'text_mm2y8bg8', prodArtFile: 'file_mm2yjme2' },
      ];

      const filesToCopy = []; // { sourceCol, targetCol } resolved after subitem is created
      for (const slot of deptCols) {
        const deptLabel = scv[slot.dept];
        if (!deptLabel) continue;
        const deptId = DEPT_LABEL_TO_ID[deptLabel];
        if (deptId) prodCV[slot.prodDept] = { ids: [deptId] };
        if (scv[slot.place]) prodCV[slot.prodPlace] = scv[slot.place];
        if (scv[slot.desc]) prodCV[slot.prodDesc] = scv[slot.desc];
        if (scv[slot.screens]) prodCV[slot.prodScreens] = parseFloat(scv[slot.screens]) || 0;
        if (scv[slot.colors]) prodCV[slot.prodColors] = scv[slot.colors];
        filesToCopy.push({ sourceCol: slot.artFile, targetCol: slot.prodArtFile });
      }

      const createSub = `mutation { create_subitem(parent_item_id: ${orderItemId}, item_name: ${JSON.stringify(sub.name)}, column_values: ${JSON.stringify(JSON.stringify(prodCV))}, create_labels_if_missing: true) { id } }`;
      const subResult = await mondayQuery(createSub);
      if (subResult.errors) { console.error('Promote subitem error:', subResult.errors); continue; }
      const newSubId = subResult.data.create_subitem.id;

      // Carry over every artwork file + the Mockups file, exactly once, so nothing gets re-uploaded
      for (const f of filesToCopy) {
        await copyFileColumn(sub.id, f.sourceCol, newSubId, f.targetCol);
      }
      await copyFileColumn(sub.id, 'file_mm64jda5', newSubId, 'file_mm26e29h'); // Mockups
    }

    // Move quote to archive group + mark Won-Promoted + link back
    const archiveCV = JSON.stringify({
      'color_mm63qxwk': { label: 'Won - Promoted' },
      'link_mm63xyxz': { url: `https://ccbimprint.monday.com/boards/${ORDERS_BOARD_ID}/pulses/${orderItemId}`, text: 'View Order' },
      'date_mm63mcnv': { date: new Date().toISOString().slice(0, 10) },
    });
    await mondayQuery(`mutation { change_multiple_column_values(item_id: ${quoteId}, board_id: ${QUOTES_BOARD_ID}, column_values: ${JSON.stringify(archiveCV)}, create_labels_if_missing: true) { id } }`);
    await mondayQuery(`mutation { move_item_to_group(item_id: ${quoteId}, group_id: "group_mm63d5wt") { id } }`);

    res.json({ ok: true, orderItemId, orderUrl: `https://ccbimprint.monday.com/boards/${ORDERS_BOARD_ID}/pulses/${orderItemId}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// REP DASHBOARD -- aggregate metrics for one rep or all (admin)
// ============================================================
app.get('/api/rep/dashboard', async (req, res) => {
  try {
    const { salesPerson, isAdmin } = req.query;
    // Always pulled live from Monday on every request -- no server-side caching here,
    // so the numbers reflect whatever is on the boards at this exact moment.
    const [allQuotes, allOrders, allNotes] = await Promise.all([
      fetchAllItems(QUOTES_BOARD_ID, 'id name group{id title} column_values{id text}'),
      fetchAllItems(ORDERS_BOARD_ID, 'id name column_values{id text}'),
      fetchAllItems(CLIENT_NOTES_BOARD_ID, 'id name column_values{id text}'),
    ]);

    const matchesRep = (cvArr, colId) => {
      const val = cvArr.find(c => c.id === colId)?.text || '';
      return isAdmin === 'true' || val.split(',').map(s => s.trim()).includes(salesPerson);
    };

    const myQuotes = allQuotes.filter(q => matchesRep(q.column_values, 'dropdown_mm63w1e'));
    const myOrders = allOrders.filter(o => matchesRep(o.column_values, 'dropdown_mm22w5rr'));
    const myNotes = allNotes.filter(n => {
      const cv = {}; n.column_values.forEach(c => cv[c.id] = c.text);
      return isAdmin === 'true' || cv['dropdown_mm64sdqh'] === salesPerson;
    });

    const quotesMade = myQuotes.length;
    const quotesWon = myQuotes.filter(q => q.group?.title?.includes('Won')).length;
    const quotesLost = myQuotes.filter(q => q.group?.title?.includes('Lost')).length;
    const quotesActive = myQuotes.filter(q => q.group?.title === 'Active Quotes');
    const winRate = quotesMade > 0 ? quotesWon / quotesMade : 0;

    const activeQuotesList = quotesActive.map(q => {
      const cv = {}; q.column_values.forEach(c => cv[c.id] = c.text);
      return {
        id: q.id,
        client: q.name,
        totalRevenue: parseFloat(cv['numeric_mm63wrys']) || 0,
        commissionAmount: parseFloat(cv['numeric_mm6381qx']) || 0,
        quoteDate: cv['date_mm63wc7v'] || '',
        status: cv['color_mm63qxwk'] || 'Draft',
      };
    }).sort((a, b) => (b.quoteDate || '').localeCompare(a.quoteDate || ''));

    let totalRevenue = 0, totalCommission = 0, commissionPaid = 0, commissionPending = 0;
    let commissionInvoicedAwaitingPayment = 0, commissionNotYetInvoiced = 0;
    const byClient = {};
    const byMonthCommission = {};
    const byMonthRevenue = {};
    const now = Date.now(); const yearMs = 365 * 24 * 60 * 60 * 1000;
    const thisMonthKey = new Date().toISOString().slice(0, 7);
    const lastMonthDate = new Date(); lastMonthDate.setMonth(lastMonthDate.getMonth() - 1);
    const lastMonthKey = lastMonthDate.toISOString().slice(0, 7);

    for (const o of myOrders) {
      const cv = {}; o.column_values.forEach(c => cv[c.id] = c.text);
      const rev = parseFloat(cv['numeric_mm4wv7sc']) || 0;
      const gp = parseFloat(cv['numeric_mm4wyq9k']) || 0;
      const comm = parseFloat(cv['numeric_mm4w38cv']) || 0;
      const invStatus = cv['color_mm282b4b'];
      const datePaid = cv['date_mm63ydka'];
      const orderDate = cv['date4'] || '';
      totalRevenue += rev;
      totalCommission += comm;
      if (invStatus === 'Paid') commissionPaid += comm;
      else {
        commissionPending += comm;
        if (invStatus === 'Invoice Created' || invStatus === 'Invoice Sent' || invStatus === 'Overdue') commissionInvoicedAwaitingPayment += comm;
        else commissionNotYetInvoiced += comm;
      }

      const trendDateStr = datePaid || orderDate;
      if (trendDateStr) {
        const monthKey = trendDateStr.slice(0, 7);
        byMonthCommission[monthKey] = (byMonthCommission[monthKey] || 0) + (invStatus === 'Paid' ? comm : 0);
      }
      if (orderDate) {
        const monthKey = orderDate.slice(0, 7);
        byMonthRevenue[monthKey] = (byMonthRevenue[monthKey] || 0) + rev;
      }

      const client = o.name;
      if (!byClient[client]) byClient[client] = { revenue12mo: 0, totalRevenue: 0, commissionAccrued: 0, commissionPaid: 0, orders: [] };
      byClient[client].totalRevenue += rev;
      byClient[client].commissionAccrued += comm;
      if (invStatus === 'Paid') byClient[client].commissionPaid += comm;
      if (orderDate) { const d = new Date(orderDate).getTime(); if (!isNaN(d) && (now - d) <= yearMs) byClient[client].revenue12mo += rev; }
      byClient[client].orders.push({
        id: o.id, date: orderDate, revenue: Math.round(rev * 100) / 100, grossProfit: Math.round(gp * 100) / 100,
        commission: Math.round(comm * 100) / 100, invoiceStatus: invStatus || 'Not Invoiced', datePaid: datePaid || null,
      });
    }

    // Attach notes to their client (kept forever -- notes are never deleted by this app)
    const notesByClient = {};
    for (const n of myNotes) {
      const cv = {}; n.column_values.forEach(c => cv[c.id] = c.text);
      const client = n.name;
      if (!notesByClient[client]) notesByClient[client] = [];
      notesByClient[client].push({
        id: n.id, note: cv['long_text_mm64gerz'] || '', date: cv['date_mm64h5jy'] || '',
        loggedAt: cv['text_mm645vgh'] || '', salesPerson: cv['dropdown_mm64sdqh'] || '',
      });
    }
    for (const client in notesByClient) notesByClient[client].sort((a, b) => (b.loggedAt || '').localeCompare(a.loggedAt || ''));

    const clients = Object.entries(byClient).map(([name, v]) => ({
      name,
      revenue12mo: Math.round(v.revenue12mo * 100) / 100,
      totalRevenue: Math.round(v.totalRevenue * 100) / 100,
      commissionAccrued: Math.round(v.commissionAccrued * 100) / 100,
      commissionPaid: Math.round(v.commissionPaid * 100) / 100,
      commissionPending: Math.round((v.commissionAccrued - v.commissionPaid) * 100) / 100,
      loyaltyPct: Math.min(100, Math.round((v.revenue12mo / 50000) * 100)),
      loyaltyUnlocked: v.revenue12mo >= 50000,
      dollarsToLoyalty: Math.max(0, Math.round((50000 - v.revenue12mo) * 100) / 100),
      orderCount: v.orders.length,
      orders: v.orders.sort((a, b) => (b.date || '').localeCompare(a.date || '')),
      notes: notesByClient[name] || [],
      lastOrderDate: v.orders.reduce((max, o) => (o.date || '') > max ? (o.date || '') : max, ''),
    })).sort((a, b) => b.revenue12mo - a.revenue12mo);

    // Clients with notes but zero orders on file still deserve a place in the notes UI
    for (const clientName in notesByClient) {
      if (!byClient[clientName]) {
        clients.push({
          name: clientName, revenue12mo: 0, totalRevenue: 0, commissionAccrued: 0, commissionPaid: 0,
          commissionPending: 0, loyaltyPct: 0, loyaltyUnlocked: false, dollarsToLoyalty: 50000,
          orderCount: 0, orders: [], notes: notesByClient[clientName], lastOrderDate: '',
        });
      }
    }

    res.json({
      generatedAt: new Date().toISOString(),
      quotesMade, quotesWon, quotesLost, winRate: Math.round(winRate * 1000) / 10,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalCommission: Math.round(totalCommission * 100) / 100,
      commissionPaid: Math.round(commissionPaid * 100) / 100,
      commissionPending: Math.round(commissionPending * 100) / 100,
      commissionInvoicedAwaitingPayment: Math.round(commissionInvoicedAwaitingPayment * 100) / 100,
      commissionNotYetInvoiced: Math.round(commissionNotYetInvoiced * 100) / 100,
      thisMonthRevenue: Math.round((byMonthRevenue[thisMonthKey] || 0) * 100) / 100,
      lastMonthRevenue: Math.round((byMonthRevenue[lastMonthKey] || 0) * 100) / 100,
      thisMonthCommission: Math.round((byMonthCommission[thisMonthKey] || 0) * 100) / 100,
      lastMonthCommission: Math.round((byMonthCommission[lastMonthKey] || 0) * 100) / 100,
      clients,
      activeQuotesList,
      monthlyCommission: Object.entries(byMonthCommission).sort((a, b) => a[0].localeCompare(b[0])).map(([month, amt]) => ({ month, amount: Math.round(amt * 100) / 100 })),
      monthlyRevenue: Object.entries(byMonthRevenue).sort((a, b) => a[0].localeCompare(b[0])).map(([month, amt]) => ({ month, amount: Math.round(amt * 100) / 100 })),
      activeQuotes: quotesActive.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CLIENT NOTES -- permanent, timestamped call/conversation
// recaps per client. Never deleted by this app; add-only.
// ============================================================
app.post('/api/rep/notes', async (req, res) => {
  try {
    const { salesPerson, client, note } = req.body;
    if (!salesPerson || !client || !note) return res.status(400).json({ error: 'salesPerson, client, and note are required' });
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();
    const cv = {
      'dropdown_mm64sdqh': { labels: [salesPerson] },
      'long_text_mm64gerz': note,
      'date_mm64h5jy': { date: today },
      'text_mm645vgh': now,
    };
    const mutation = `mutation { create_item(board_id: ${CLIENT_NOTES_BOARD_ID}, item_name: ${JSON.stringify(client)}, column_values: ${JSON.stringify(JSON.stringify(cv))}, create_labels_if_missing: true) { id } }`;
    const result = await mondayQuery(mutation);
    if (result.errors) return res.status(400).json({ error: result.errors[0].message });
    res.json({ ok: true, noteId: result.data.create_item.id, date: today, loggedAt: now });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PAYOUT REPORT -- admin only. Mirrors the Excel Commission
// Summary: pick a pay period, get the exact $ payable this
// period (Invoice Status = Paid, Date Paid within range),
// broken out per rep.
// ============================================================
app.get('/api/rep/payout-report', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end dates required' });

    const items = await fetchAllItems(ORDERS_BOARD_ID, 'id name column_values{id text}');

    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();
    const byRep = {};
    let totalPayable = 0, totalRevenue = 0, totalGP = 0, pendingCount = 0, pendingCommission = 0;

    for (const item of items) {
      const cv = {}; item.column_values.forEach(c => cv[c.id] = c.text);
      const invStatus = cv['color_mm282b4b'];
      const datePaid = cv['date_mm63ydka'];
      const comm = parseFloat(cv['numeric_mm4w38cv']) || 0;
      const rev = parseFloat(cv['numeric_mm4wv7sc']) || 0;
      const gp = parseFloat(cv['numeric_mm4wyq9k']) || 0;
      const rep = cv['dropdown_mm22w5rr'] || 'Unassigned';

      if (invStatus === 'Paid' && datePaid) {
        const paidMs = new Date(datePaid).getTime();
        if (!isNaN(paidMs) && paidMs >= startMs && paidMs <= endMs) {
          totalPayable += comm; totalRevenue += rev; totalGP += gp;
          byRep[rep] = (byRep[rep] || 0) + comm;
        }
      } else if (invStatus !== 'Paid') {
        pendingCount++;
        pendingCommission += comm;
      }
    }

    res.json({
      start, end,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalGrossProfit: Math.round(totalGP * 100) / 100,
      totalPayable: Math.round(totalPayable * 100) / 100,
      pendingCount,
      pendingCommission: Math.round(pendingCommission * 100) / 100,
      byRep: Object.entries(byRep).map(([name, amount]) => ({ name, amount: Math.round(amount * 100) / 100 })).sort((a, b) => b.amount - a.amount),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Clear a file column entirely -- used by the "Replace mockup"
// quick action so a wrong image doesn't just get piled on top of.
// Monday's file columns have no selective single-file removal via
// API, so a full clear + fresh upload is the reliable way to swap.
// ============================================================
app.post('/api/clear-file-column', async (req, res) => {
  try {
    const { itemId, columnId, boardId } = req.body;
    if (!itemId || !columnId) return res.status(400).json({ error: 'itemId and columnId required' });

    // change_column_value requires board_id -- look it up if the caller didn't pass one
    let resolvedBoardId = boardId;
    if (!resolvedBoardId) {
      const lookup = await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY, 'API-Version': '2024-01' },
        body: JSON.stringify({ query: `{items(ids:[${itemId}]){board{id}}}` })
      });
      const lookupData = await lookup.json();
      resolvedBoardId = lookupData.data?.items?.[0]?.board?.id;
      if (!resolvedBoardId) return res.status(400).json({ error: 'Could not resolve board_id for this item' });
    }

    const mutation = `mutation { change_column_value(item_id: ${itemId}, board_id: ${resolvedBoardId}, column_id: "${columnId}", value: "{}") { id } }`;
    const r = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY, 'API-Version': '2024-01' },
      body: JSON.stringify({ query: mutation })
    });
    const data = await r.json();
    if (data.errors) return res.status(400).json({ error: data.errors[0].message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// LEGACY ORDER COST REVIEW -- one-time cost entry on pre-Quotes-
// tool orders that never had real cost data (showed 100% margin).
// Only works on orders flagged Legacy Order=true, and only once
// per order (Legacy Cost Edited flips true after the first save
// and blocks any further edits). Orders created going forward
// through the Quotes tool are never eligible -- Legacy Order is
// explicitly false on those.
// ============================================================
app.get('/api/legacy-orders/needs-review', async (req, res) => {
  try {
    const items = await fetchAllItems(ORDERS_BOARD_ID, 'id name column_values(ids:["date4","dropdown_mm22w5rr","numeric_mm4wv7sc","numeric_mm4wyq9k","numeric_mm4w38cv","numeric_mm64z51s","numeric_mm64ce5z","boolean_mm6446x5","boolean_mm64wetc"]){id text}');
    const rows = items.map(item => {
      const cv = {}; item.column_values.forEach(c => cv[c.id] = c.text);
      return {
        id: item.id, name: item.name, date: cv['date4'] || '',
        salesPerson: cv['dropdown_mm22w5rr'] || '',
        revenue: parseFloat(cv['numeric_mm4wv7sc']) || 0,
        grossProfit: parseFloat(cv['numeric_mm4wyq9k']) || 0,
        commission: parseFloat(cv['numeric_mm4w38cv']) || 0,
        commissionRate: parseFloat(cv['numeric_mm64z51s']) || 0,
        legacyCost: cv['numeric_mm64ce5z'] ? parseFloat(cv['numeric_mm64ce5z']) : null,
        isLegacy: cv['boolean_mm6446x5'] === 'v',
        costEdited: cv['boolean_mm64wetc'] === 'v',
      };
    }).filter(o => o.isLegacy && o.revenue > 0 && o.grossProfit === o.revenue && !o.costEdited);
    res.json({ orders: rows.sort((a, b) => (b.date || '').localeCompare(a.date || '')) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/legacy-orders/edit-cost', async (req, res) => {
  try {
    const { orderId, cost } = req.body;
    if (!orderId || cost == null) return res.status(400).json({ error: 'orderId and cost required' });

    const query = `{items(ids:[${orderId}]){column_values(ids:["numeric_mm4wv7sc","numeric_mm64z51s","boolean_mm6446x5","boolean_mm64wetc"]){id text}}}`;
    const data = await mondayQuery(query);
    const cv = {}; (data.data?.items?.[0]?.column_values || []).forEach(c => cv[c.id] = c.text);

    if (cv['boolean_mm6446x5'] !== 'v') return res.status(403).json({ error: 'This is not a legacy order -- costs on current orders are set at quote time and cannot be edited.' });
    if (cv['boolean_mm64wetc'] === 'v') return res.status(403).json({ error: 'The cost on this order has already been edited once and is now locked.' });

    const revenue = parseFloat(cv['numeric_mm4wv7sc']) || 0;
    const rate = parseFloat(cv['numeric_mm64z51s']) || 0;
    const newCost = Math.max(0, Number(cost));
    const newGP = revenue - newCost;
    const newCommission = newGP * rate;

    const updateCV = JSON.stringify(JSON.stringify({
      'numeric_mm64ce5z': newCost,
      'numeric_mm4wyq9k': Math.round(newGP * 100) / 100,
      'numeric_mm4w38cv': Math.round(newCommission * 100) / 100,
      'boolean_mm64wetc': { checked: 'true' },
    }));
    const mutation = `mutation { change_multiple_column_values(board_id: ${ORDERS_BOARD_ID}, item_id: ${orderId}, column_values: ${updateCV}) { id } }`;
    const result = await mondayQuery(mutation);
    if (result.errors) return res.status(400).json({ error: result.errors[0].message });

    res.json({ ok: true, grossProfit: Math.round(newGP * 100) / 100, commission: Math.round(newCommission * 100) / 100 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/legacy-orders/reassign-rep', async (req, res) => {
  try {
    const { orderId, salesPerson } = req.body;
    if (!orderId || !salesPerson) return res.status(400).json({ error: 'orderId and salesPerson required' });
    const cv = JSON.stringify(JSON.stringify({ 'dropdown_mm22w5rr': { labels: [salesPerson] } }));
    const mutation = `mutation { change_multiple_column_values(board_id: ${ORDERS_BOARD_ID}, item_id: ${orderId}, column_values: ${cv}, create_labels_if_missing: true) { id } }`;
    const result = await mondayQuery(mutation);
    if (result.errors) return res.status(400).json({ error: result.errors[0].message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`CCB Tools server running on port ${PORT}`);
});
