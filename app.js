const BOARD_ID = '18407165363';
let currentOrderData = null;

function getApiKey() { return localStorage.getItem('ccb_monday_token') || ''; }

function saveApiKey(panel) {
  var input = document.getElementById('api-key-input-' + panel);
  var token = input ? input.value.trim() : '';
  if (!token) { alert('Please paste your monday.com API token first.'); return; }
  localStorage.setItem('ccb_monday_token', token);
  var badge = document.getElementById('saved-badge-' + panel);
  if (badge) badge.style.display = 'flex';
  checkSetupNotices();
  alert('Token saved successfully!');
}

function checkSetupNotices() {
  var token = getApiKey();
  ['packing','netsuite'].forEach(function(p) {
    var el = document.getElementById('setup-notice-' + p);
    if (el) el.style.display = token ? 'none' : 'block';
  });
}

function switchTab(tab, btn) {
  document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
  document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
  document.getElementById('panel-' + tab).classList.add('active');
  btn.classList.add('active');
}

function setStatus(panel, type, msg) {
  var el = document.getElementById(panel + '-status');
  el.className = 'status ' + type;
  el.innerHTML = type === 'loading' ? '<span class="spinner"></span>' + msg : msg;
}

function clearStatus(panel) {
  var el = document.getElementById(panel + '-status');
  el.className = 'status';
  el.innerHTML = '';
}

function resetPanel(panel) {
  document.getElementById(panel + '-result').style.display = 'none';
  document.getElementById(panel + '-input').value = '';
  clearStatus(panel);
  currentOrderData = null;
}

function formatDate(s) {
  if (!s) return '—';
  return new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });
}

function fmtMDY(d) {
  return (d.getMonth()+1).toString().padStart(2,'0') + '/' + d.getDate().toString().padStart(2,'0') + '/' + d.getFullYear();
}

function todayMDY() { return fmtMDY(new Date()); }

function net30MDY() {
  var d = new Date();
  d.setDate(d.getDate() + 30);
  return fmtMDY(d);
}

function mondayQuery(query) {
  var token = getApiKey();
  if (!token) return Promise.reject(new Error('No API token saved. Enter your monday.com API token above.'));
  return fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token,
      'API-Version': '2024-01'
    },
    body: JSON.stringify({ query: query })
  }).then(function(res) {
    if (!res.ok) throw new Error('API error ' + res.status);
    return res.json();
  }).then(function(data) {
    if (data.errors) throw new Error(data.errors[0].message);
    return data.data;
  });
}

function fetchOrderByCCB(ccbNum) {
  var query = '{ boards(ids:[' + BOARD_ID + ']) { items_page(limit:5, query_params:{rules:[{column_id:"text_mm29djkk",compare_value:["' + ccbNum + '"]}]}) { items { id name column_values(ids:["pulse_id_mm27vwa5","text_mm29djkk","text_mm221kg3","date_mm22wpk2","text_mm26gtxp","location_mm2682nc","boolean_mm22xdfn","text_mm253t97","long_text_mm225vbf","dropdown_mm22w5rr"]) { id text value } subitems { id name column_values(ids:["text_mm22fv7y","text_mm2276wz","text_mm22yw8s","dropdown_mm22dn1f","numeric_mm22crjt","numeric_mm2299qw"]) { id text value } } } } } }';
  return mondayQuery(query).then(function(data) {
    var items = data && data.boards && data.boards[0] && data.boards[0].items_page && data.boards[0].items_page.items;
    if (!items || items.length === 0) throw new Error('No order found for ' + ccbNum);
    return items[0];
  });
}

function pc(cols) {
  var m = {};
  cols.forEach(function(c) { m[c.id] = { text: c.text, value: c.value }; });
  return m;
}

function fetchOrder(panel) {
  var raw = document.getElementById(panel + '-input').value.trim().toUpperCase();
  if (!raw) return;
  var ccbNum = raw.startsWith('CCB-') ? raw : 'CCB-' + raw.padStart(5,'0');
  setStatus(panel, 'loading', 'Fetching ' + ccbNum + '...');
  document.getElementById(panel + '-result').style.display = 'none';
  document.getElementById(panel + '-btn').disabled = true;

  fetchOrderByCCB(ccbNum).then(function(item) {
    currentOrderData = item;
    clearStatus(panel);
    if (panel === 'packing') renderPacking(item, ccbNum);
    else renderNS(item, ccbNum);
    document.getElementById(panel + '-result').style.display = 'block';
  }).catch(function(e) {
    setStatus(panel, 'error', '❌ ' + e.message);
  }).finally(function() {
    document.getElementById(panel + '-btn').disabled = false;
  });
}

function renderPacking(item, ccbNum) {
  var c = pc(item.column_values);
  document.getElementById('ps-company').textContent = item.name;
  document.getElementById('ps-ccb-num').textContent = ccbNum;
  document.getElementById('ps-order-num').textContent = ccbNum;
  document.getElementById('ps-due-date').textContent = formatDate(c['date_mm22wpk2'] && c['date_mm22wpk2'].text) || '—';
  document.getElementById('ps-ship-to').textContent = (c['text_mm26gtxp'] && c['text_mm26gtxp'].text) || item.name;
  document.getElementById('ps-contact').textContent = (c['text_mm221kg3'] && c['text_mm221kg3'].text) || '—';
  document.getElementById('ps-address').textContent = (c['location_mm2682nc'] && c['location_mm2682nc'].text) || '—';
  document.getElementById('ps-sales').textContent = (c['dropdown_mm22w5rr'] && c['dropdown_mm22w5rr'].text) || '—';

  var tbody = document.getElementById('ps-items-body');
  tbody.innerHTML = '';
  (item.subitems || []).forEach(function(sub) {
    var sc = pc(sub.column_values);
    var tr = document.createElement('tr');
    tr.innerHTML = '<td><span class="item-name">' + sub.name + '</span></td>' +
      '<td>' + ((sc['text_mm22fv7y'] && sc['text_mm22fv7y'].text) || '—') + '</td>' +
      '<td>' + ((sc['text_mm2276wz'] && sc['text_mm2276wz'].text) || '—') + '</td>' +
      '<td>' + ((sc['text_mm22yw8s'] && sc['text_mm22yw8s'].text) || '—') + '</td>' +
      '<td>' + ((sc['dropdown_mm22dn1f'] && sc['dropdown_mm22dn1f'].text) || '—') + '</td>' +
      '<td style="text-align:right;font-family:var(--mono);font-weight:600">' + ((sc['numeric_mm22crjt'] && sc['numeric_mm22crjt'].text) || '—') + '</td>';
    tbody.appendChild(tr);
  });

  var specVal = c['boolean_mm22xdfn'] && c['boolean_mm22xdfn'].value;
  var specNotes = c['text_mm253t97'] && c['text_mm253t97'].text;
  var specBox = document.getElementById('ps-spec-box');
  try {
    if (specVal && JSON.parse(specVal).checked) {
      specBox.style.display = 'block';
      document.getElementById('ps-spec-notes').innerHTML = '<span class="spec-badge">Required</span>' + (specNotes || 'See order notes.');
    } else { specBox.style.display = 'none'; }
  } catch(e) { specBox.style.display = 'none'; }

  var notes = c['long_text_mm225vbf'] && c['long_text_mm225vbf'].text;
  var notesBox = document.getElementById('ps-notes-box');
  if (notes && notes.trim()) {
    notesBox.style.display = 'block';
    document.getElementById('ps-notes').textContent = notes;
  } else { notesBox.style.display = 'none'; }
}

function renderNS(item, ccbNum) {
  var c = pc(item.column_values);
  document.getElementById('ns-company').textContent = item.name;
  document.getElementById('ns-ccb-num').textContent = ccbNum;
  document.getElementById('ns-date').textContent = todayMDY();
  document.getElementById('ns-due').textContent = net30MDY();
  document.getElementById('ns-po').textContent = ccbNum;

  var tbody = document.getElementById('ns-items-body');
  tbody.innerHTML = '';
  var total = 0;
  (item.subitems || []).forEach(function(sub) {
    var sc = pc(sub.column_values);
    var qty = parseFloat((sc['numeric_mm22crjt'] && sc['numeric_mm22crjt'].text) || 0) || 0;
    var rate = parseFloat((sc['numeric_mm2299qw'] && sc['numeric_mm2299qw'].text) || 0) || 0;
    var amt = qty * rate;
    total += amt;
    var tr = document.createElement('tr');
    tr.innerHTML = '<td><span class="item-name">' + sub.name + '</span></td>' +
      '<td style="text-align:right;font-family:var(--mono)">' + qty + '</td>' +
      '<td style="text-align:right;font-family:var(--mono)">$' + rate.toFixed(2) + '</td>' +
      '<td style="text-align:right;font-family:var(--mono)">$' + amt.toFixed(2) + '</td>';
    tbody.appendChild(tr);
  });
  var totTr = document.createElement('tr');
  totTr.className = 'total-row';
  totTr.innerHTML = '<td colspan="3" style="text-align:right;font-size:0.78rem;letter-spacing:1px;text-transform:uppercase">Total</td><td style="font-family:var(--mono)">$' + total.toFixed(2) + '</td>';
  tbody.appendChild(totTr);
}

function downloadCSV() {
  if (!currentOrderData) return;
  var item = currentOrderData;
  var c = pc(item.column_values);
  var ccbNum = (c['text_mm29djkk'] && c['text_mm29djkk'].text) || item.name;
  var rows = [['External ID','Customer','Date','PO #','Item','Quantity','Description','Rate','Amount','Due Date','Terms']];
  (item.subitems || []).forEach(function(sub) {
    var sc = pc(sub.column_values);
    var qty = parseFloat((sc['numeric_mm22crjt'] && sc['numeric_mm22crjt'].text) || 0) || 0;
    var rate = parseFloat((sc['numeric_mm2299qw'] && sc['numeric_mm2299qw'].text) || 0) || 0;
    var desc = sub.name.replace(/"/g, '""');
    rows.push([ccbNum, '"' + item.name.replace(/"/g,'""') + '"', todayMDY(), ccbNum, '', qty, '"' + desc + '"', rate.toFixed(2), (qty*rate).toFixed(2), net30MDY(), 'Net 30']);
  });
  var csv = rows.map(function(r) { return r.join(','); }).join('\r\n');
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv;charset=windows-1252;'}));
  a.download = ccbNum + '-invoice.csv';
  a.click();
}

// Init on page load
document.addEventListener('DOMContentLoaded', function() {
  checkSetupNotices();
  ['packing-input','netsuite-input'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) {
      el.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') fetchOrder(id.replace('-input',''));
      });
    }
  });
});
