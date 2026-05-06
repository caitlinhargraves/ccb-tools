const express = require('express');
const cron = require('node-cron');
const path = require('path');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const MONDAY_API_KEY = process.env.MONDAY_API_KEY || 'eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjY0OTQ0NjE4NywiYWFpIjoxMSwidWlkIjoxMDE3MTA4NjgsImlhZCI6IjIwMjYtMDQtMjNUMTU6Mzc6MTkuMDAwWiIsInBlciI6Im1lOndyaXRlIiwiYWN0aWQiOjM0NDk0MDk3LCJyZ24iOiJ1c2UxIn0.6FPYgwwTj-05GWXHxxq5lSstcJTGfVOqATNhk5FQBic';
const ORDERS_BOARD_ID = '18407165363';
const CCB_EMAIL = 'info@ccbimprint.com';

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

// Serve static files
// Basic Auth middleware -- protects entire site
app.use((req, res, next) => {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;

  // Skip auth if env vars not set (dev mode)
  if (!user || !pass) return next();

  const authHeader = req.headers['authorization'] || '';
  const b64 = authHeader.startsWith('Basic ') ? authHeader.slice(6) : '';
  const [u, p] = Buffer.from(b64, 'base64').toString().split(':');

  if (u === user && p === pass) return next();

  res.set('WWW-Authenticate', 'Basic realm="CCB Tools"');
  res.status(401).send('Authentication required');
});

app.use(express.static(path.join(__dirname)));
app.use(express.json({ limit: '5mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
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
    const query = `{
      boards(ids: [${ORDERS_BOARD_ID}]) {
        items_page(limit: 500) {
          items {
            id name created_at updated_at
            group { id }
            column_values { id text value }
            subitems {
              id name
              column_values { id text value }
            }
          }
        }
      }
    }`;
    const response = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY, 'API-Version': '2024-01' },
      body: JSON.stringify({ query })
    });
    const data = await response.json();
    if (data.errors) { console.error('Monday API errors:', data.errors); cache.isLoading = false; return; }
    cache.orders = data.data.boards[0].items_page.items;
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
// In-memory inventory store (persists while server is alive)
// For production, swap with a SQLite file or Render disk mount
// ============================================================
let inventoryStore = {
  categories: ['Gift Boxes', 'Birthday Gifts', 'Office Supplies', 'Production Supplies', 'Thread'],
  items: [],
  threadColors: []
};

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
  res.json(inventoryStore);
});

app.post('/api/inventory', (req, res) => {
  const { categories, items, threadColors } = req.body;
  if (categories) inventoryStore.categories = categories;
  if (items) inventoryStore.items = items;
  if (threadColors) inventoryStore.threadColors = threadColors;

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

app.listen(PORT, () => {
  console.log(`CCB Tools server running on port ${PORT}`);
});
