/*
 * Storage connectors. Each connector is one object:
 *
 *   {
 *     id, name, blurb,
 *     fields: [{ key, label, type, placeholder, hint }],
 *     test(config)            -> Promise<string>   (message on success; throws on failure)
 *     send(payload, config)   -> Promise<{ photoUrl?, overlayUrl? }>
 *   }
 *
 * payload = { row: {COLUMN: value, ...}, photo: base64|null, overlay: base64|null }
 *
 * To add a platform (Excel/OneDrive, Airtable, Supabase, ...), add an object
 * to CONNECTORS with the same shape. Nothing else in the app changes.
 */
(function () {
  "use strict";

  // One row per leaf. The first block matches BLS_results.csv from the R pipeline.
  var COLUMNS = [
    "Record_ID", "Timestamp", "Trial", "Plot_ID", "Genotype", "Rep", "Leaf_No", "Rater",
    "Image_File", "Leaf_Pixels", "Healthy_Pixels", "Chlorotic_Pixels", "Necrotic_Pixels",
    "Healthy_Percent", "Chlorotic_Percent", "Necrotic_Percent", "Total_Diseased_Percent",
    "BLS_Score", "Disease_Response", "QC_Status",
    "Latitude", "Longitude", "GPS_Accuracy_m", "Notes",
    "Image_Width", "Image_Height", "Engine_Version", "Device", "Photo_URL", "Overlay_URL",
    "Sections", "Edited_At", "Segmentation", "Rules", "Leaf_Count",
    "Per_Leaf_Diseased_Percent", "Per_Leaf_BLS_Score",
    "Lesion_Count", "Mean_Lesion_Size_Percent", "Visual_BLS_Score",
    // Study mode: the rater's own estimate, made before the app's score was shown
    "Visual_Diseased_Percent", "Rating_Mode", "Rating_Seconds", "Rated_At", "Set_Position"
  ];

  function postJson(url, body, headers, plain) {
    // Google Apps Script cannot answer a CORS preflight, so it gets text/plain
    // (a "simple" request). Webhooks get proper application/json.
    var h = Object.assign({ "Content-Type": plain ? "text/plain;charset=utf-8" : "application/json" }, headers || {});
    return fetch(url, { method: "POST", headers: h, body: JSON.stringify(body), redirect: "follow" })
      .then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
          if (!res.ok) throw new Error("The server answered " + res.status + (data && data.error ? ": " + data.error : ""));
          if (data && data.ok === false) throw new Error(data.error || "The server refused the record.");
          return data || {};
        });
      }, function () {
        throw new Error("Could not reach the address. Check the link and that you are online.");
      });
  }

  function requireUrl(cfg, key) {
    var u = (cfg[key] || "").trim();
    if (!/^https:\/\//i.test(u)) throw new Error("Enter the full https:// address first.");
    return u;
  }

  var CONNECTORS = [
    {
      id: "local",
      name: "This phone only",
      blurb: "Keep records on this phone. Export a CSV from the Records tab whenever you need it.",
      fields: [],
      test: function () { return Promise.resolve("Records are saved on this phone."); },
      send: function () { return Promise.resolve({}); }
    },
    {
      id: "googleSheets",
      name: "Google Sheets + Drive",
      blurb: "One row per leaf in your own Google Sheet. Photos go to a folder in your Google Drive.",
      fields: [
        { key: "url", label: "Web app link", type: "url", placeholder: "https://script.google.com/macros/s/…/exec",
          hint: "Open the template Sheet, then Extensions → Apps Script → Deploy → New deployment (Web app, access: Anyone). Paste the link it gives you." },
        { key: "key", label: "Team key", type: "password", placeholder: "Same as TEAM_KEY in the script",
          hint: "Stops strangers from writing to your Sheet." }
      ],
      test: function (cfg) {
        return Promise.resolve().then(function () {
          var url = requireUrl(cfg, "url");
          return postJson(url, { action: "ping", key: cfg.key || "" }, null, true);
        }).then(function (d) {
          return "Connected to “" + (d.sheet || "your Sheet") + "”.";
        });
      },
      send: function (payload, cfg) {
        var url = requireUrl(cfg, "url");
        return postJson(url, {
          action: "append", key: cfg.key || "", columns: COLUMNS,
          row: payload.row, photo: payload.photo, overlay: payload.overlay, thumb: payload.thumb
        }, null, true);
      }
    },
    {
      id: "webhook",
      name: "Webhook (any platform)",
      blurb: "Send each record as JSON to any address: Zapier, Make, n8n, Power Automate, or your lab server.",
      fields: [
        { key: "url", label: "Webhook address", type: "url", placeholder: "https://hooks.example.org/bls" },
        { key: "header", label: "Header name (optional)", type: "text", placeholder: "Authorization" },
        { key: "token", label: "Header value (optional)", type: "password", placeholder: "Bearer …" }
      ],
      test: function (cfg) {
        return Promise.resolve().then(function () {
          var url = requireUrl(cfg, "url");
          var h = {}; if (cfg.header && cfg.token) h[cfg.header] = cfg.token;
          return postJson(url, { event: "test", app: "BLS Leaf Scorer" }, h);
        }).then(function () { return "The webhook accepted a test message."; });
      },
      send: function (payload, cfg) {
        var url = requireUrl(cfg, "url");
        var h = {}; if (cfg.header && cfg.token) h[cfg.header] = cfg.token;
        return postJson(url, {
          event: payload.event || "record", columns: COLUMNS, row: payload.row,
          photo_jpeg_base64: payload.photo, overlay_jpeg_base64: payload.overlay
        }, h);
      }
    },
    { id: "excel", name: "Excel / OneDrive", blurb: "Microsoft 365 sign-in.", soon: true, fields: [] },
    { id: "airtable", name: "Airtable", blurb: "Personal access token.", soon: true, fields: [] },
    { id: "supabase", name: "Supabase", blurb: "Your own Postgres database.", soon: true, fields: [] }
  ];

  window.BLSConnectors = {
    COLUMNS: COLUMNS,
    list: CONNECTORS,
    get: function (id) {
      return CONNECTORS.filter(function (c) { return c.id === id && !c.soon; })[0] || CONNECTORS[0];
    }
  };
})();
