/**
 * BLS Leaf Scorer: Google Sheets + Drive receiver.
 *
 * Each person or lab runs this inside THEIR OWN Google Sheet, so records go
 * straight from the phone to their Sheet and Drive. No third-party server.
 *
 * Setup (about 3 minutes):
 *   1. Create a Google Sheet (any name, e.g. "BLS Trial 2026").
 *   2. Extensions → Apps Script. Delete what is there and paste this file.
 *   3. Change TEAM_KEY below to a password your team will share. Save.
 *   4. Deploy → New deployment → type "Web app".
 *        Execute as: Me
 *        Who has access: Anyone
 *      Click Deploy and approve the permissions (Sheets + Drive, your account only).
 *   5. Copy the Web app URL (ends in /exec). In the app: Settings →
 *      Google Sheets + Drive → paste the URL and the team key → Test → Save.
 *
 * Rows go to a tab called "BLS_results". Photos and overlays go to a Drive
 * folder called "BLS Leaf Scorer photos", and their links are written into the row.
 * Sending the same Record_ID twice updates the row instead of adding a duplicate.
 * From app 0.10, a "Photo" column shows a thumbnail of each leaf inside the Sheet,
 * and Study mode adds Visual_Diseased_Percent, Rating_Mode (blind / after),
 * Rating_Seconds, Rated_At and Set_Position. Updating an existing deployment:
 * paste this file again, then Deploy → Manage deployments → Edit → Version: New.
 */

var TEAM_KEY = "change-me";
var SHEET_NAME = "BLS_results";
var FOLDER_NAME = "BLS Leaf Scorer photos";
var THUMB_COL = "Photo";          // in-cell thumbnail of the leaf (added by app 0.10+)
var THUMB_ROW_HEIGHT = 90;        // px; set to 0 to keep normal row height

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var body = JSON.parse(e.postData.contents);
    if (TEAM_KEY && body.key !== TEAM_KEY) return reply({ ok: false, error: "Wrong team key" });

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (body.action === "ping") return reply({ ok: true, sheet: ss.getName() });
    if (body.action !== "append") return reply({ ok: false, error: "Unknown action" });

    var columns = body.columns;
    var row = body.row || {};
    var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(columns);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, columns.length).setFontWeight("bold");
    }
    var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    // Add any columns a newer app version sends
    columns.forEach(function (c) {
      if (header.indexOf(c) === -1) {
        header.push(c);
        sheet.getRange(1, header.length).setValue(c).setFontWeight("bold");
      }
    });

    var urls = {};
    if (body.photo || body.overlay) {
      var folder = getFolder();
      var base = safeName([row.Trial, row.Plot_ID, row.Rep && "R" + row.Rep, row.Leaf_No && "L" + row.Leaf_No, row.Record_ID.slice(0, 8)]);
      if (body.photo) urls.photoUrl = saveImage(folder, body.photo, base + "_photo.jpg");
      if (body.overlay) urls.overlayUrl = saveImage(folder, body.overlay, base + "_overlay.jpg");
    }
    if (urls.photoUrl) row.Photo_URL = urls.photoUrl;
    if (urls.overlayUrl) row.Overlay_URL = urls.overlayUrl;

    // A small copy of the photo shown inside the Sheet (study review at a glance)
    if (body.thumb && header.indexOf(THUMB_COL) === -1) {
      header.push(THUMB_COL);
      sheet.getRange(1, header.length).setValue(THUMB_COL).setFontWeight("bold");
    }

    var values = header.map(function (c) { return c === THUMB_COL || row[c] === undefined ? "" : row[c]; });
    var idCol = header.indexOf("Record_ID") + 1;
    var existing = findRow(sheet, idCol, row.Record_ID);
    if (existing) sheet.getRange(existing, 1, 1, values.length).setValues([values]);
    else { sheet.appendRow(values); existing = sheet.getLastRow(); }
    if (body.thumb) putThumb(sheet, existing, header.indexOf(THUMB_COL) + 1, body.thumb);

    return reply({ ok: true, photoUrl: urls.photoUrl || "", overlayUrl: urls.overlayUrl || "" });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// Puts the photo inside the cell. Needs no public sharing: the image data is
// sent by the app as a small JPEG. If Google refuses it, the row is still saved
// and Photo_URL still links to the full photo in Drive.
function putThumb(sheet, rowNo, colNo, b64) {
  try {
    var img = SpreadsheetApp.newCellImage().setSourceUrl("data:image/jpeg;base64," + b64)
      .setAltTextTitle("Leaf photo").build();
    sheet.getRange(rowNo, colNo).setValue(img);
    if (THUMB_ROW_HEIGHT) sheet.setRowHeight(rowNo, THUMB_ROW_HEIGHT);
  } catch (err) {
    sheet.getRange(rowNo, colNo).setValue("(thumbnail not supported: see Photo_URL)");
  }
}

function findRow(sheet, col, id) {
  if (!id || sheet.getLastRow() < 2) return 0;
  var hit = sheet.getRange(2, col, sheet.getLastRow() - 1, 1).createTextFinder(id).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}

function getFolder() {
  var it = DriveApp.getFoldersByName(FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER_NAME);
}

function saveImage(folder, b64, name) {
  var blob = Utilities.newBlob(Utilities.base64Decode(b64), "image/jpeg", name);
  return folder.createFile(blob).getUrl();
}

function safeName(parts) {
  return parts.filter(String).join("_").replace(/[^\w.-]+/g, "-");
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
