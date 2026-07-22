const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;
const ADJ  = process.env.ADJ_BIN_RACK || 'ADJ'; // adjustment bin rack name

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Linnworks credentials ──────────────────────────────────────────────────────
const APP_ID     = process.env.LINNWORKS_APP_ID;
const APP_SECRET = process.env.LINNWORKS_APP_SECRET;
const APP_TOKEN  = process.env.LINNWORKS_TOKEN;

// ── Redis (optional — session persistence) ─────────────────────────────────────
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(...args) {
  if (!REDIS_URL) return null;
  try {
    const r = await fetch(`${REDIS_URL}/${args.map(a => encodeURIComponent(a)).join('/')}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    return (await r.json()).result;
  } catch (e) { console.error('Redis:', e.message); return null; }
}

async function appendLog(entry) {
  if (!REDIS_URL) return;
  await redis('lpush', 'sc_logs', JSON.stringify(entry));
  await redis('ltrim', 'sc_logs', '0', '49999');
}

async function readLog(limit = 10000) {
  if (!REDIS_URL) return [];
  const items = await redis('lrange', 'sc_logs', '0', String(limit - 1));
  if (!Array.isArray(items)) return [];
  return items.map(i => { try { return JSON.parse(i); } catch (_) { return null; } }).filter(Boolean);
}

// ── Staff sessions ─────────────────────────────────────────────────────────────
const sessions = new Map();

async function saveSession(token, data) {
  if (!REDIS_URL) return;
  const ttl = Math.floor((data.expiry - Date.now()) / 1000);
  if (ttl > 0) await redis('set', `sc_sess:${token}`, JSON.stringify(data), 'ex', String(ttl));
}
async function delSession(token) {
  if (REDIS_URL) await redis('del', `sc_sess:${token}`);
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  let users = {};
  try { users = JSON.parse(process.env.STAFF_USERS || '{}'); } catch (_) {
    return res.status(500).json({ error: 'Staff users not configured' });
  }
  const user = users[username.toLowerCase()];
  if (!user || user.password !== password) return res.status(401).json({ error: 'Wrong username or password' });
  const token = crypto.randomBytes(32).toString('hex');
  const data  = { username: username.toLowerCase(), displayName: user.displayName || username, expiry: Date.now() + 8 * 3600000 };
  sessions.set(token, data);
  saveSession(token, data);
  res.json({ token, displayName: data.displayName });
});

app.post('/api/logout', (req, res) => {
  const t = req.headers['x-auth-token'];
  if (t) { sessions.delete(t); delSession(t); }
  res.json({ ok: true });
});

async function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  let sess = sessions.get(token);
  if (!sess && REDIS_URL) {
    try {
      const raw = await redis('get', `sc_sess:${token}`);
      if (raw) { sess = JSON.parse(raw); if (Date.now() < sess.expiry) sessions.set(token, sess); else sess = null; }
    } catch (_) {}
  }
  if (!sess || Date.now() > sess.expiry) return res.status(401).json({ error: 'Not authenticated' });
  req.user = sess;
  next();
}

// ── Linnworks session ──────────────────────────────────────────────────────────
let lw = { token: null, server: null, expiry: 0 };

async function getSession() {
  if (lw.token && Date.now() < lw.expiry) return lw;
  const r = await fetch('https://api.linnworks.net/api/Auth/AuthorizeByApplication', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ApplicationId: APP_ID, ApplicationSecret: APP_SECRET, Token: APP_TOKEN }).toString()
  });
  if (!r.ok) throw new Error(`Linnworks auth failed: ${r.status}`);
  const d = await r.json();
  lw = { token: d.Token, server: d.Server, expiry: Date.now() + 28 * 60000 };
  console.log('✅ Linnworks session ok:', lw.server);
  return lw;
}

async function lwPost(endpoint, body) {
  const s = await getSession();
  const r = await fetch(`${s.server}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: s.token },
    body
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`${endpoint}: ${r.status} ${t}`); }
  return r.json();
}

// ── Helper: warehouse move ─────────────────────────────────────────────────────
async function warehouseMove(batchInventoryId, destBinRackId, qty, note) {
  const res = await lwPost('Stock/CreateWarehouseMove',
    `request=${encodeURIComponent(JSON.stringify({
      BatchInventoryId: batchInventoryId,
      BinrackIdDestination: destBinRackId,
      Quantity: qty,
      TxType: 'InTransit',
      Note: note, Notes: note, UserName: note, ChangeNote: note
    }))}`
  );
  const moveId = res.WarehouseMove && res.WarehouseMove.MoveId;
  if (moveId) {
    // Mirror transfer app: try both ID formats, silently ignore if complete fails
    // (Linnworks sometimes auto-completes or uses a different ID field)
    try {
      await lwPost('Stock/CompleteWarehouseMove',
        `request=${encodeURIComponent(JSON.stringify({ MoveId: moveId }))}`
      );
    } catch (_) {
      try {
        await lwPost('Stock/CompleteWarehouseMove',
          `request=${encodeURIComponent(JSON.stringify({ WarehouseMoveId: moveId }))}`
        );
      } catch (_) {
        // Silently ignore — Linnworks may auto-complete the move
        console.log(`CompleteWarehouseMove failed for ${moveId} — move may auto-complete`);
      }
    }
  }
  return moveId;
}

// ── Helper: find bin rack ID ───────────────────────────────────────────────────
async function findBinRackId(binRack, locationId, stockItemId = '00000000-0000-0000-0000-000000000000') {
  const res = await lwPost('Stock/SearchBinracks',
    `request=${encodeURIComponent(JSON.stringify({ BinRack: binRack, LocationId: locationId, StockItemId: stockItemId, PageNumber: 1 }))}`
  );
  const found = (res.BinRacks || []).find(b => b.BinRack === binRack) || (res.BinRacks || [])[0];
  return found ? found.BinRackId : null;
}

// ── Helper: find BatchInventoryId for item in a bin rack ──────────────────────
async function findBatchId(binRackId, stockItemId) {
  const res = await lwPost('Stock/GetBinrackSkus',
    `request=${encodeURIComponent(JSON.stringify({ BinRackId: binRackId, DetailLevel: [] }))}`
  );
  for (const batch of (res.Skus || [])) {
    if (String(batch.StockItemId).toLowerCase() === String(stockItemId).toLowerCase()) {
      for (const inv of (batch.Inventory || [])) {
        if (!inv.IsDeleted && inv.BinRackId === binRackId) return inv.BatchInventoryId;
      }
    }
  }
  return null;
}

// ── GET /api/health ────────────────────────────────────────────────────────────
app.get('/api/health', requireAuth, async (req, res) => {
  try { await getSession(); res.json({ ok: true, user: req.user.displayName }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/locations ─────────────────────────────────────────────────────────
app.get('/api/locations', requireAuth, async (req, res) => {
  try {
    const s = await getSession();
    let data = null;
    for (const ep of ['Inventory/GetInventoryLocations', 'Stock/GetStockLocations']) {
      try {
        const r = await fetch(`${s.server}/api/${ep}`, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: s.token }, body: ''
        });
        if (r.ok) { data = await r.json(); break; }
      } catch (_) {}
    }
    const list = Array.isArray(data) ? data : (data && (data.Results || data.StockLocations)) || [];
    const mapped = list.map(l => ({ StockLocationId: l.StockLocationId || l.LocationId || '', LocationName: l.LocationName || l.Name || '' })).filter(l => l.LocationName);
    if (mapped.length) return res.json(mapped);
    // Fallback to known locations if API returns nothing
    throw new Error('Empty response');
  } catch (e) {
    // Hardcoded fallback — same as transfer app
    res.json([
      { StockLocationId: '28f60e93-7de6-4983-9d2d-6631d9d2a8c1', LocationName: 'WMS New' },
      { StockLocationId: '', LocationName: 'Default' }
    ]);
  }
});

// ── GET /api/binrack?locationId=&binRack= ─────────────────────────────────────
// Returns items currently in the bin rack with their BatchInventoryId
app.get('/api/binrack', requireAuth, async (req, res) => {
  const { locationId, binRack } = req.query;
  if (!locationId || !binRack) return res.status(400).json({ error: 'locationId and binRack required' });
  try {
    const searchRes = await lwPost('Stock/SearchBinracks',
      `request=${encodeURIComponent(JSON.stringify({ BinRack: binRack, LocationId: locationId, StockItemId: '00000000-0000-0000-0000-000000000000', PageNumber: 1 }))}`
    );
    const found = (searchRes.BinRacks || []).find(b => b.BinRack === binRack) || (searchRes.BinRacks || [])[0];
    if (!found) return res.json({ binRackId: null, items: [] });

    const skuRes = await lwPost('Stock/GetBinrackSkus',
      `request=${encodeURIComponent(JSON.stringify({ BinRackId: found.BinRackId, DetailLevel: [] }))}`
    );

    const items = [];
    for (const batch of (skuRes.Skus || [])) {
      // Linnworks sometimes returns Inventory, sometimes Item — handle both
      const invList = batch.Inventory || batch.Item || [];
      for (const inv of invList) {
        // Match by BinRackId OR by BinRack name (case-insensitive) — same pattern as transfer app
        const idMatch   = inv.BinRackId && found.BinRackId &&
                          String(inv.BinRackId).toLowerCase() === String(found.BinRackId).toLowerCase();
        const nameMatch = inv.BinRack && String(inv.BinRack).toUpperCase() === binRack.toUpperCase();
        if (!inv.IsDeleted && (idMatch || nameMatch)) {
          items.push({
            stockItemId:      batch.StockItemId,
            sku:              batch.SKU,
            title:            batch.ItemTitle || '',
            systemQty:        inv.Quantity,
            batchInventoryId: inv.BatchInventoryId,
            binRackId:        found.BinRackId
          });
        }
      }
    }
    console.log(`[binrack] ${binRack}: found ${items.length} items`);
    res.json({ binRackId: found.BinRackId, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/search?sku= ──────────────────────────────────────────────────────
app.get('/api/search', requireAuth, async (req, res) => {
  const sku = (req.query.sku || '').trim();
  if (!sku) return res.status(400).json({ error: 'sku required' });
  try {
    const dataReq = encodeURIComponent(JSON.stringify(['StockLevels']));
    let list = [];
    for (const type of ['SKU', 'Barcode']) {
      const body = `keyword=${encodeURIComponent(sku)}&loadCompositeParents=false&loadVariationParents=false&entriesPerPage=10&pageNumber=1&dataRequirements=${dataReq}&searchTypes=${encodeURIComponent(JSON.stringify([type]))}`;
      try { const d = await lwPost('Stock/GetStockItemsFull', body); if (Array.isArray(d) && d.length) { list = d; break; } } catch (_) {}
    }
    if (!list.length) return res.status(404).json({ error: `Not found: ${sku}` });
    const item = list.find(i => (i.ItemNumber||'').toLowerCase() === sku.toLowerCase() || (i.BarcodeNumber||'').toLowerCase() === sku.toLowerCase()) || list[0];
    res.json({ stockItemId: item.StockItemId, sku: item.ItemNumber, title: item.ItemTitle });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/count-commit ────────────────────────────────────────────────────
// changes: [{ sku, title, stockItemId, delta, batchInventoryId }]
// delta < 0 → reduction (move excess to ADJ)
// delta > 0 → addition (move from ADJ to bin rack, or fallback)
app.post('/api/count-commit', requireAuth, async (req, res) => {
  const { changes, binRack, locationId } = req.body;
  if (!changes || !binRack || !locationId) return res.status(400).json({ error: 'changes, binRack and locationId required' });

  const staffName = req.user ? req.user.displayName : 'Unknown';
  const note      = `Stock Count by ${staffName}`;
  const results   = [];

  // Pre-fetch bin rack IDs we'll need
  let adjId     = null;
  let countedId = null;
  try { adjId     = await findBinRackId(ADJ, locationId); } catch (_) {}
  try { countedId = await findBinRackId(binRack, locationId); } catch (_) {}

  for (const change of changes) {
    const { sku, title, stockItemId, delta, batchInventoryId } = change;
    try {

      // ── REDUCTION ────────────────────────────────────────────────────────────
      if (delta < 0) {
        if (!batchInventoryId) throw new Error('No batch ID — item may have already been moved');
        if (!adjId) throw new Error(`ADJ bin rack not found in this location — check it exists`);
        await warehouseMove(batchInventoryId, adjId, Math.abs(delta), note);
        results.push({ sku, success: true, action: `−${Math.abs(delta)} moved to ADJ` });

      // ── ADDITION ─────────────────────────────────────────────────────────────
      } else if (delta > 0) {
        let done = false;

        // Try: move from ADJ to this bin rack
        if (adjId && countedId) {
          try {
            const adjBatchId = await findBatchId(adjId, stockItemId);
            if (adjBatchId) {
              await warehouseMove(adjBatchId, countedId, delta, note);
              done = true;
              results.push({ sku, success: true, action: `+${delta} moved from ADJ` });
            }
          } catch (e) { console.log(`Move from ADJ failed for ${sku}:`, e.message); }
        }

        // Fallback: try stock level adjustment API
        if (!done) {
          const s = await getSession();
          const r = await fetch(`${s.server}/api/Stock/AdjustStockLevel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: s.token },
            body: `request=${encodeURIComponent(JSON.stringify({ StockItemId: stockItemId, ChangeInQty: delta, LocationId: locationId, BinRack: binRack, Notes: note }))}`
          });
          if (r.ok) {
            done = true;
            results.push({ sku, success: true, action: `+${delta} via stock adjustment` });
          } else {
            const txt = await r.text();
            results.push({ sku, success: false, error: `Item not in ADJ and API failed. Put ${delta} unit(s) of ${sku} into ADJ bin rack, then try again. (${txt})` });
          }
        }
      }

      // Log success
      if (results[results.length - 1]?.success) {
        appendLog({ timestamp: new Date().toISOString(), user: staffName, sku, title: title || '', delta, binRack });
      }

    } catch (e) {
      results.push({ sku, success: false, error: e.message });
    }
  }

  res.json({ results, allOk: results.every(r => r.success) });
});

// ── GET /api/logs ──────────────────────────────────────────────────────────────
app.get('/api/logs', requireAuth, async (req, res) => {
  const logs = await readLog(parseInt(req.query.limit) || 10000);
  res.json(logs);
});

// ── Serve frontend ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🔢 Stock Count app running on port ${PORT}`));
