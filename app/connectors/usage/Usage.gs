/**
 * BLS Leaf Scorer: anonymous device counter (for the app's developer).
 *
 * Every copy of the app sends one small message a day:
 *   a random device ID (not linked to any name), app version, platform,
 *   installed or browser, language and continent.
 * No names, ratings, photos or locations are ever sent.
 *
 * Setup (once, about 5 minutes, on a computer):
 *   1. Create a new Google Sheet, e.g. "BLS Leaf Scorer usage".
 *   2. Extensions → Apps Script. Delete what is there and paste this file. Save.
 *   3. Deploy → New deployment → type "Web app".
 *        Execute as: Me        Who has access: Anyone
 *      Deploy, approve the permissions, and copy the Web app URL (ends in /exec).
 *   4. Put that URL in the app (USAGE_URL in study/app.js) and publish the app.
 * The "Devices" tab gets one row per device; the "Summary" tab counts them.
 */

var DEVICES = "Devices";
var SUMMARY = "Summary";
var COLS = ["Device", "First_Seen", "Last_Seen", "Days_Opened", "App_Version", "Platform", "Opened_As", "App", "Language", "Region"];

function doPost(e) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return reply({ ok: false });
  try {
    var b = JSON.parse(e.postData.contents || "{}");
    // only messages from the app, with a well-formed random ID
    if (b.t !== "bls-usage-1" || !/^[A-Za-z0-9-]{8,40}$/.test(String(b.id || ""))) return reply({ ok: false });
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(DEVICES) || setup(ss);
    var now = new Date();
    var info = [clean(b.v, 12), clean(b.p, 12), clean(b.m, 10), clean(b.a, 10), clean(b.l, 12), clean(b.r, 16)];
    var hit = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(b.id).matchEntireCell(true).findNext() : null;
    if (hit) {
      var r = hit.getRow();
      var days = Number(sh.getRange(r, 4).getValue()) || 0;
      sh.getRange(r, 3, 1, 8).setValues([[now, days + 1].concat(info)]);
    } else {
      sh.appendRow([b.id, now, now, 1].concat(info));
    }
    return reply({ ok: true });
  } catch (err) {
    return reply({ ok: false });
  } finally {
    lock.releaseLock();
  }
}

// Quick look in a browser: open the Web app URL to see the totals
function doGet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(DEVICES);
  if (!sh || sh.getLastRow() < 2) return reply({ devices: 0, active30: 0 });
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues();
  var cut = Date.now() - 30 * 864e5, active = 0;
  rows.forEach(function (r) { if (r[2] && new Date(r[2]).getTime() >= cut) active++; });
  return reply({ devices: rows.length, active30: active });
}

function setup(ss) {
  var sh = ss.insertSheet(DEVICES);
  sh.appendRow(COLS);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, COLS.length).setFontWeight("bold");
  var s = ss.getSheetByName(SUMMARY) || ss.insertSheet(SUMMARY, 0);
  s.clear();
  var d = "'" + DEVICES + "'!";
  var rows = [
    ["BLS Leaf Scorer usage (anonymous devices)", ""],
    ["Devices ever", "=COUNTA(" + d + "A2:A)"],
    ["Active in the last 7 days", "=COUNTIF(" + d + "C2:C,\">=\"&(TODAY()-7))"],
    ["Active in the last 30 days", "=COUNTIF(" + d + "C2:C,\">=\"&(TODAY()-30))"],
    ["Opened as installed app", "=COUNTIF(" + d + "G2:G,\"installed\")"],
    ["Opened in a browser", "=COUNTIF(" + d + "G2:G,\"browser\")"],
    ["", ""],
    ["By platform", ""],
    ["=QUERY(" + d + "A1:J,\"select F, count(A) where A is not null group by F order by count(A) desc label count(A) 'Devices'\",1)", ""]
  ];
  s.getRange(1, 1, rows.length, 2).setValues(rows);
  s.getRange("D8").setValue("By region");
  s.getRange("D9").setFormula("=QUERY(" + d + "A1:J,\"select J, count(A) where A is not null group by J order by count(A) desc label count(A) 'Devices'\",1)");
  s.getRange("G8").setValue("By app version");
  s.getRange("G9").setFormula("=QUERY(" + d + "A1:J,\"select E, count(A) where A is not null group by E order by E desc label count(A) 'Devices'\",1)");
  s.getRange("J8").setValue("New devices per month");
  s.getRange("J9").setFormula("=QUERY(" + d + "A1:J,\"select year(B), month(B)+1, count(A) where A is not null group by year(B), month(B)+1 label year(B) 'Year', month(B)+1 'Month', count(A) 'New devices'\",1)");
  s.getRange("A1").setFontWeight("bold").setFontSize(13);
  s.getRange("A8:J8").setFontWeight("bold");
  s.setColumnWidth(1, 230);
  return sh;
}

function clean(v, n) { return String(v == null ? "" : v).replace(/[^\w .\-\/]/g, "").slice(0, n); }

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
