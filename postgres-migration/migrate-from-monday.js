// ============================================================
// One-time (re-runnable) migration: Monday.com -> Postgres.
// This only READS from Monday -- nothing here writes back to
// Monday or deletes anything there. Safe to run as many times
// as needed while testing; every insert upserts on monday_item_id
// so re-running just refreshes the copy, it never duplicates rows.
//
// Usage: MONDAY_API_KEY=... DATABASE_URL=... node migrate-from-monday.js
// ============================================================
const pool = require('./db');

const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
if (!MONDAY_API_KEY) { console.error('MONDAY_API_KEY not set'); process.exit(1); }

const ORDERS_BOARD_ID = '18407165363';
const PRODUCTS_BOARD_ID = '18407165552';
const QUOTES_BOARD_ID = '18425958662';
const QUOTES_SUB_BOARD_ID = '18425958868';
const REP_BOARD_ID = '18425958984';
const CLIENT_NOTES_BOARD_ID = '18426058971';
const TIME_LOG_BOARD_ID = '18426071636';
const DAMAGE_BOARD_ID = '18426071714';
const TASKS_BOARD_ID = '18426075295';
const INVENTORY_BOARD_ID = '18412170163';
const GIFT_BOXES_BOARD_ID = '18409662777';

async function mondayQuery(query) {
  const r = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY, 'API-Version': '2024-01' },
    body: JSON.stringify({ query }),
  });
  const d = await r.json();
  if (d.errors) console.error('Monday API error:', JSON.stringify(d.errors));
  return d;
}

async function fetchAllItems(boardId, itemsFragment) {
  let all = [];
  let cursor = null;
  do {
    const pageArg = cursor ? `cursor: ${JSON.stringify(cursor)}` : 'limit: 500';
    const q = `{boards(ids:[${boardId}]){items_page(${pageArg}){cursor items{${itemsFragment}}}}}`;
    const d = await mondayQuery(q);
    const page = d.data?.boards?.[0]?.items_page;
    if (!page) break;
    all = all.concat(page.items || []);
    cursor = page.cursor;
  } while (cursor);
  return all;
}

function cv(item) { const m = {}; (item.column_values || []).forEach(c => m[c.id] = c.text); return m; }
function num(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }
function bool(v) { return v === 'v' || v === true; }
function dateOrNull(v) { return v && v.trim() ? v : null; }
function fileUrls(rawValue) {
  // File columns come back as text like "file1.png, file2.png" -- for a real
  // migration you'd resolve each to a public_url via the assets API and
  // re-upload to real storage. Flagged as a deliberate follow-up: this
  // script captures the filenames now so nothing is silently lost, but the
  // actual binary re-hosting is a separate pass once a storage backend
  // (S3 / Supabase storage / Render disk) is chosen.
  if (!rawValue) return [];
  return rawValue.split(',').map(s => s.trim()).filter(Boolean);
}

async function upsert(table, uniqueCol, row) {
  const cols = Object.keys(row);
  const vals = cols.map(c => row[c]);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const updates = cols.filter(c => c !== uniqueCol).map(c => `${c} = EXCLUDED.${c}`).join(', ');
  const q = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
             ON CONFLICT (${uniqueCol}) DO UPDATE SET ${updates}
             RETURNING id`;
  const res = await pool.query(q, vals);
  return res.rows[0].id;
}

async function migrateOrders() {
  console.log('Migrating orders...');
  const items = await fetchAllItems(ORDERS_BOARD_ID, `id name column_values{id text}`);
  const idMap = {}; // monday_item_id -> postgres id
  for (const it of items) {
    const c = cv(it);
    const pgId = await upsert('orders', 'monday_item_id', {
      monday_item_id: it.id,
      name: it.name,
      contact_name: c['text_mm221kg3'] || null,
      email: c['email_mm22ap28'] || null,
      phone: c['phone_mm22ertc'] || null,
      ship_to: c['text_mm26gtxp'] || null,
      addr_street: c['text_mm64qzxz'] || null,
      addr_city: c['text_mm64ed37'] || null,
      addr_state: c['text_mm648wbf'] || null,
      addr_zip: c['text_mm64mgf8'] || null,
      payment_method: c['text_mm22t49y'] || null,
      order_status: c['color_mm27qyta'] || null,
      invoice_status: c['color_mm282b4b'] || null,
      sales_person: c['dropdown_mm22w5rr'] || null,
      imprint_or_insight: c['dropdown_mm276wtz'] || null,
      in_hands_date: dateOrNull(c['date_mm22wpk2']),
      order_submitted_date: dateOrNull(c['date4']),
      invoice_sent_date: dateOrNull(c['date_mm2c9nmg']),
      date_paid: dateOrNull(c['date_mm63ydka']),
      revenue: num(c['numeric_mm4wv7sc']) || 0,
      gross_profit: num(c['numeric_mm4wyq9k']) || 0,
      commission: num(c['numeric_mm4w38cv']) || 0,
      commission_rate: num(c['numeric_mm64z51s']) || 0,
      ccb_order_number: c['text_mm29djkk'] || null,
      other_charges: num(c['numeric_mm222s2j']) || 0,
      other_charges_details: c['long_text_mm22zdh2'] || null,
      notes: c['long_text_mm225vbf'] || null,
      is_legacy: bool(c['boolean_mm6446x5']),
      legacy_cost_edited: bool(c['boolean_mm64wetc']),
      legacy_total_cost: num(c['numeric_mm64ce5z']),
    });
    idMap[it.id] = pgId;
  }
  console.log(`  ${items.length} orders migrated`);
  return idMap;
}

async function migrateProducts(orderIdMap) {
  console.log('Migrating order products...');
  const items = await fetchAllItems(PRODUCTS_BOARD_ID, `id name parent_item{id} column_values{id text}`);
  let count = 0;
  const productIdMap = {};
  for (const it of items) {
    const c = cv(it);
    const orderId = orderIdMap[it.parent_item?.id];
    if (!orderId) continue; // parent order wasn't migrated (shouldn't happen, but don't orphan rows)
    const pgId = await upsert('order_products', 'monday_item_id', {
      monday_item_id: it.id,
      order_id: orderId,
      name: it.name,
      style_sku: c['text_mm22fv7y'] || null,
      product_type: c['color_mm2dd6d5'] || null,
      product_status: c['color_mm25v786'] || null,
      supplier: c['text_mm22qdag'] || null,
      color: c['text_mm2276wz'] || null,
      size: c['text_mm22yw8s'] || null,
      quantity: num(c['numeric_mm22crjt']),
      price_per_item: num(c['numeric_mm2299qw']),
      cost_per_item: num(c['numeric_mm266zz9']),
      po_number: c['text_mm27ns9d'] || null,
      po_date: dateOrNull(c['date_mm26mc76']),
      production_notes: c['long_text_mm27e9c4'] || null,
      mockup_urls: JSON.stringify(fileUrls(c['file_mm26e29h'])),
      deco_1_type: c['dropdown_mm2y4w39'] || null, deco_1_placement: c['text_mm2y6g62'] || null, deco_1_colors: c['text_mm2y2y6a'] || null, deco_1_desc: c['text_mm2y3mb9'] || null, deco_1_screens: num(c['numeric_mm2yn2nb']), deco_1_art_urls: JSON.stringify(fileUrls(c['file_mm2y1yem'])), deco_1_notes: c['long_text_mm3yw3sd'] || null,
      deco_2_type: c['dropdown_mm2yaxxz'] || null, deco_2_placement: c['text_mm2yge79'] || null, deco_2_colors: c['text_mm2y5vn6'] || null, deco_2_desc: c['text_mm2ymf5k'] || null, deco_2_screens: num(c['numeric_mm2ynqby']), deco_2_art_urls: JSON.stringify(fileUrls(c['file_mm2ya55c'])), deco_2_notes: c['long_text_mm3yxdjc'] || null,
      deco_3_type: c['dropdown_mm2ygyew'] || null, deco_3_placement: c['text_mm2y1j6j'] || null, deco_3_colors: c['text_mm2y8bg8'] || null, deco_3_desc: c['text_mm2yjq0z'] || null, deco_3_screens: num(c['numeric_mm2y55qh']), deco_3_art_urls: JSON.stringify(fileUrls(c['file_mm2yjme2'])), deco_3_notes: c['long_text_mm3y77fa'] || null,
    });
    productIdMap[it.id] = pgId;
    count++;
  }
  console.log(`  ${count} order products migrated`);
  return productIdMap;
}

async function migrateReps() {
  console.log('Migrating reps...');
  const items = await fetchAllItems(REP_BOARD_ID, `id name column_values{id text}`);
  for (const it of items) {
    const c = cv(it);
    await upsert('reps', 'monday_item_id', {
      monday_item_id: it.id,
      name: it.name,
      role: c['color_mm63fnqv'] || 'Sales Rep',
      password_hash: c['text_mm63mwrn'] || null,
      sales_person: c['text_mm6380j8'] || null,
      active: (c['color_mm635y4q'] || 'Active') === 'Active',
    });
  }
  console.log(`  ${items.length} reps migrated`);
}

async function migrateQuotes() {
  console.log('Migrating quotes...');
  const items = await fetchAllItems(QUOTES_BOARD_ID, `id name subitems{id} column_values{id text}`);
  const idMap = {};
  for (const it of items) {
    const c = cv(it);
    const pgId = await upsert('quotes', 'monday_item_id', {
      monday_item_id: it.id,
      client_name: it.name,
      contact_name: c['text_mm639ee3'] || null,
      email: c['email_mm63ex5f'] || null,
      phone: c['phone_mm635egd'] || null,
      sales_person: c['dropdown_mm63w1e'] || null,
      quote_type: c['color_mm63gx38'] || null,
      order_type: c['color_mm639bpf'] || null,
      status: c['color_mm63qxwk'] || 'Draft',
      client_order_number: num(c['numeric_mm63tz48']),
      rolling_12mo_revenue_at_quote: num(c['numeric_mm63xaq7']),
      commission_rate: num(c['numeric_mm63k849']),
      total_revenue: num(c['numeric_mm63wrys']),
      total_cost: num(c['numeric_mm63d3v6']),
      gross_profit: num(c['numeric_mm63wxbd']),
      commission_amount: num(c['numeric_mm6381qx']),
      gross_margin_pct: num(c['numeric_mm63jvbw']),
      quote_date: dateOrNull(c['date_mm63wc7v']),
      notes: c['long_text_mm63bzx4'] || null,
      promoted_date: dateOrNull(c['date_mm63mcnv']),
    });
    idMap[it.id] = pgId;
  }
  console.log(`  ${items.length} quotes migrated`);
  return idMap;
}

async function migrateQuoteLineItems(quoteIdMap) {
  console.log('Migrating quote line items...');
  const items = await fetchAllItems(QUOTES_SUB_BOARD_ID, `id name parent_item{id} column_values{id text}`);
  let count = 0;
  for (const it of items) {
    const c = cv(it);
    const quoteId = quoteIdMap[it.parent_item?.id];
    if (!quoteId) continue;
    await upsert('quote_line_items', 'monday_item_id', {
      monday_item_id: it.id,
      quote_id: quoteId,
      name: it.name,
      style_sku: c['text_mm64r1ka'] || null,
      quantity: num(c['numeric_mm63dqd9']),
      sell_price_per_unit: num(c['numeric_mm63e2t8']),
      garment_cost_per_unit: num(c['numeric_mm63p5ha']),
      screens_regular: num(c['numeric_mm63wt0j']),
      screens_large: num(c['numeric_mm63fc9y']),
      rush_fee: num(c['numeric_mm638g7h']),
      art_hours: num(c['numeric_mm63v7rq']),
      deco_cost_per_unit: num(c['numeric_mm63mz1e']),
      min_price_floor: num(c['numeric_mm63hz7j']),
      line_total_revenue: num(c['numeric_mm6311md']),
      line_total_cost: num(c['numeric_mm63svmk']),
      line_gross_profit: num(c['numeric_mm6314ad']),
      artwork_description: c['text_mm63pdpj'] || null,
      notes: c['long_text_mm6365bn'] || null,
      deco_1_type: c['dropdown_mm6390a0'] || null, deco_1_color_size: c['text_mm63crtv'] || null, deco_1_dept: c['dropdown_mm64kdgh'] || null, deco_1_placement: c['text_mm647jqe'] || null,
      deco_2_type: c['dropdown_mm63j73'] || null, deco_2_color_size: c['text_mm63cqht'] || null, deco_2_dept: c['dropdown_mm64m4m8'] || null, deco_2_placement: c['text_mm64wvjr'] || null,
      deco_3_type: c['dropdown_mm633q95'] || null, deco_3_color_size: c['text_mm632xb7'] || null, deco_3_dept: c['dropdown_mm64a9eh'] || null, deco_3_placement: c['text_mm64fbdj'] || null,
      mockup_urls: JSON.stringify(fileUrls(c['file_mm64jda5'])),
    });
    count++;
  }
  console.log(`  ${count} quote line items migrated`);
}

async function migrateClientNotes() {
  console.log('Migrating client notes...');
  const items = await fetchAllItems(CLIENT_NOTES_BOARD_ID, `id name column_values{id text}`);
  for (const it of items) {
    const c = cv(it);
    await upsert('client_notes', 'monday_item_id', {
      monday_item_id: it.id,
      client_name: it.name,
      sales_person: c['dropdown_mm64sdqh'] || null,
      note: c['long_text_mm64gerz'] || '',
      note_date: dateOrNull(c['date_mm64h5jy']) || new Date().toISOString().slice(0, 10),
      logged_at: c['text_mm645vgh'] || new Date().toISOString(),
    });
  }
  console.log(`  ${items.length} client notes migrated`);
}

async function migrateTimeLogs(productIdMap) {
  console.log('Migrating production time logs...');
  const items = await fetchAllItems(TIME_LOG_BOARD_ID, `id name column_values{id text}`);
  for (const it of items) {
    const c = cv(it);
    await upsert('production_time_logs', 'monday_item_id', {
      monday_item_id: it.id,
      job_name: it.name,
      order_product_id: productIdMap[c['text_mm6496dd']] || null,
      order_name: c['text_mm643fsg'] || null,
      worker: c['dropdown_mm64pyar'] || 'Unknown',
      department: c['dropdown_mm64wccd'] || null,
      status: c['color_mm64srw8'] || 'Active',
      start_time: c['text_mm64gtfw'] || null,
      last_resume_time: c['text_mm643txq'] || null,
      end_time: c['text_mm64fj60'] || null,
      accumulated_seconds: num(c['numeric_mm64wfkr']) || 0,
      active_duration_seconds: num(c['numeric_mm64rs82']),
    });
  }
  console.log(`  ${items.length} time logs migrated`);
}

async function migrateDamagedGoods(productIdMap) {
  console.log('Migrating damaged goods log...');
  const items = await fetchAllItems(DAMAGE_BOARD_ID, `id name column_values{id text}`);
  for (const it of items) {
    const c = cv(it);
    await upsert('damaged_goods', 'monday_item_id', {
      monday_item_id: it.id,
      job_name: it.name,
      order_product_id: productIdMap[c['text_mm64tbtf']] || null,
      order_name: c['text_mm644dat'] || null,
      worker: c['dropdown_mm64eknx'] || null,
      department: c['dropdown_mm64p7xf'] || null,
      quantity: num(c['numeric_mm64whf6']),
      cost_impact: num(c['numeric_mm648zpa']),
      reason: c['long_text_mm64de88'] || null,
      reported_at: c['text_mm64zgx0'] || new Date().toISOString(),
    });
  }
  console.log(`  ${items.length} damage reports migrated`);
}

async function migrateTasks() {
  console.log('Migrating rep tasks...');
  const items = await fetchAllItems(TASKS_BOARD_ID, `id name column_values{id text}`);
  for (const it of items) {
    const c = cv(it);
    await upsert('rep_tasks', 'monday_item_id', {
      monday_item_id: it.id,
      task_group_id: c['text_mm642s41'] || null,
      name: it.name,
      sales_person: c['dropdown_mm64e4g3'] || '',
      description: c['long_text_mm64bnmb'] || null,
      started_date: dateOrNull(c['date_mm64ee0e']) || new Date().toISOString().slice(0, 10),
      progress: c['color_mm64s1aj'] || 'Not Started',
      progress_notes: c['text_mm645cvp'] || null,
      definition_of_done: c['long_text_mm64z08g'] || null,
      completed: bool(c['boolean_mm64s7af']),
      completed_date: dateOrNull(c['date_mm64t4wb']),
    });
  }
  console.log(`  ${items.length} tasks migrated`);
}

async function migrateCatchAll(boardId, table) {
  console.log(`Migrating ${table} (catch-all)...`);
  const items = await fetchAllItems(boardId, `id name column_values{id text}`);
  for (const it of items) {
    await upsert(table, 'monday_item_id', {
      monday_item_id: it.id,
      name: it.name,
      raw_columns: JSON.stringify(cv(it)),
    });
  }
  console.log(`  ${items.length} rows migrated`);
}

async function main() {
  console.log('=== Monday -> Postgres migration starting ===');
  console.log('(read-only against Monday -- nothing there is modified or deleted)\n');

  const orderIdMap = await migrateOrders();
  const productIdMap = await migrateProducts(orderIdMap);
  await migrateReps();
  const quoteIdMap = await migrateQuotes();
  await migrateQuoteLineItems(quoteIdMap);
  await migrateClientNotes();
  await migrateTimeLogs(productIdMap);
  await migrateDamagedGoods(productIdMap);
  await migrateTasks();
  await migrateCatchAll(INVENTORY_BOARD_ID, 'inventory');
  await migrateCatchAll(GIFT_BOXES_BOARD_ID, 'gift_boxes');

  console.log('\n=== Migration complete ===');
  await pool.end();
}

main().catch(err => { console.error('Migration failed:', err); process.exit(1); });
