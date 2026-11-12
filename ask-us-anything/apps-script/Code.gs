/**
 * Ask Us Anything short list: saves picks and notes from the team site
 * into two tabs of this spreadsheet ("Site picks" and "Site notes").
 * It reads and writes only those two tabs.
 */
var PICKS = ['key', 'question', 'from', 'picked by', 'at'];
var NOTES = ['id', 'card', 'question', 'note', 'by', 'at'];

function tab_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(name);
  if (!s) { s = ss.insertSheet(name, ss.getNumSheets()); s.appendRow(headers); s.setFrozenRows(1); }
  return s;
}
function rows_(s) { return s.getLastRow() < 2 ? [] : s.getRange(2, 1, s.getLastRow() - 1, s.getLastColumn()).getValues(); }
function safe_(v, max) {
  v = String(v == null ? '' : v).slice(0, max);
  return /^[=+\-@]/.test(v) ? "'" + v : v;   // never let text become a formula
}
function state_() {
  var picks = rows_(tab_('Site picks', PICKS)).filter(function (r) { return r[0]; })
    .map(function (r) { return { key: String(r[0]), by: String(r[3]), at: Number(r[4]) || 0 }; });
  var notes = rows_(tab_('Site notes', NOTES)).filter(function (r) { return r[0]; })
    .map(function (r) { return { id: String(r[0]), card: String(r[1]), text: String(r[3]), by: String(r[4]), at: Number(r[5]) || 0 }; });
  return { picks: picks, notes: notes };
}
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function deleteWhere_(s, col, value) {
  var v = rows_(s);
  for (var i = v.length - 1; i >= 0; i--) if (String(v[i][col]) === value) s.deleteRow(i + 2);
}
function doGet() { return out_(state_()); }
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    var b = JSON.parse(e.postData.contents);
    var key = String(b.key || b.card || '');
    if (!/^[a-z0-9]{1,24}$/.test(key) && b.action !== 'delnote') return out_({ error: 'bad key' });
    var by = safe_(b.by, 40);
    if (b.action === 'pick') {
      var p = tab_('Site picks', PICKS); deleteWhere_(p, 0, key);
      p.appendRow([key, safe_(b.q, 300), safe_(b.from, 120), by, Date.now()]);
    } else if (b.action === 'unpick') {
      deleteWhere_(tab_('Site picks', PICKS), 0, key);
    } else if (b.action === 'note') {
      if (!String(b.text || '').trim()) return out_({ error: 'empty note' });
      tab_('Site notes', NOTES).appendRow(['n' + Date.now() + Math.floor(Math.random() * 1000), key, safe_(b.q, 300), safe_(b.text, 2000), by, Date.now()]);
    } else if (b.action === 'delnote') {
      deleteWhere_(tab_('Site notes', NOTES), 0, String(b.id || ''));
    } else {
      return out_({ error: 'unknown action' });
    }
    return out_(state_());
  } catch (err) {
    return out_({ error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}
