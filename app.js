
const ORIGIN_COUNTRY = "DE";
const DEFAULT_ZONE_MODE = "ALL";

const STATE = {
  rates: [],
  zones: [],
  floaterConfig: {},
  forwarders: [],
  ready: false,
};

const ZONE_MODE_BY_FORWARDER = {
  morrisson: "Morrisson",
};

function normalizeHeader(value) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\u0000/g, "")
    .trim()
    .toLowerCase();
}

function normalizeKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function parseNumberDE(value) {
  if (value == null) return NaN;
  const raw = String(value).trim();
  if (!raw) return NaN;
  return Number(raw.replace(/\./g, "").replace(/,/g, "."));
}

function money(value) {
  return Number.isFinite(value)
    ? value.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €"
    : "—";
}

async function fetchTextSmart(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} konnte nicht geladen werden (HTTP ${response.status})`);
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  let encoding = "utf-8";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";

  return new TextDecoder(encoding).decode(buffer);
}

function detectDelimiter(text) {
  const sample = text.split(/\r?\n/).slice(0, 5).join("\n");
  const counts = {
    ';': (sample.match(/;/g) || []).length,
    '\t': (sample.match(/\t/g) || []).length,
    ',': (sample.match(/,/g) || []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] || ';';
}

function parseCsv(text) {
  const delimiter = detectDelimiter(text);
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const rows = [];

  for (const line of lines) {
    const cells = [];
    let current = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') {
        if (quoted && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = !quoted;
        }
      } else if (char === delimiter && !quoted) {
        cells.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    cells.push(current.trim());
    rows.push(cells);
  }
  return rows;
}

function getZoneMode(forwarder) {
  return ZONE_MODE_BY_FORWARDER[normalizeKey(forwarder)] || DEFAULT_ZONE_MODE;
}

function getFloaterPercent(forwarder) {
  const key = normalizeKey(forwarder);
  const value = STATE.floaterConfig[key];
  return Number.isFinite(value) ? value : 0;
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function detectZoneColumns(headers) {
  const columns = [];
  headers.forEach((header, index) => {
    const match = String(header).trim().match(/^zone\s*(\d+)$/i);
    if (match) columns.push({ index, zone: Number(match[1]) });
  });
  return columns;
}

async function loadZones() {
  const rows = parseCsv(await fetchTextSmart("zones.csv"));
  const headers = rows[0].map(normalizeHeader);
  const iForwarder = headers.indexOf("forwarder");
  const iOrigin = headers.indexOf("origin ctry");
  const iDest = headers.indexOf("dest ctry");
  const iFrom = headers.indexOf("dest from");
  const iTo = headers.indexOf("dest to");
  const iZone = headers.indexOf("zone");

  if ([iForwarder, iOrigin, iDest, iFrom, iTo, iZone].some((i) => i < 0)) {
    throw new Error("zones.csv: Header konnte nicht gelesen werden.");
  }

  STATE.zones = rows.slice(1)
    .filter((row) => row[iForwarder])
    .map((row) => ({
      forwarder: row[iForwarder].trim(),
      originCountry: row[iOrigin].trim(),
      destCountry: row[iDest].trim(),
      from: parseNumberDE(row[iFrom]),
      to: parseNumberDE(row[iTo]),
      zone: Number.parseInt(String(row[iZone]).trim(), 10),
    }))
    .filter((row) => Number.isFinite(row.from) && Number.isFinite(row.to) && Number.isFinite(row.zone));
}

async function loadRates() {
  const rows = parseCsv(await fetchTextSmart("rates.csv"));
  const headersRaw = rows[0];
  const headers = headersRaw.map(normalizeHeader);
  const iForwarder = headers.indexOf("forwarder");
  const iOrigin = headers.indexOf("origin ctry");
  const iDest = headers.indexOf("dest ctry");
  const iFrom = headers.indexOf("chg from");
  const iTo = headers.indexOf("chg to");
  const iUnit = headers.indexOf("unit");
  const zoneCols = detectZoneColumns(headersRaw);

  if ([iForwarder, iOrigin, iDest, iFrom, iTo, iUnit].some((i) => i < 0) || zoneCols.length === 0) {
    throw new Error("rates.csv: Header konnte nicht gelesen werden.");
  }

  STATE.rates = rows.slice(1)
    .filter((row) => row[iForwarder])
    .map((row) => {
      const zonePrices = new Map();
      zoneCols.forEach(({ index, zone }) => {
        const amount = parseNumberDE(row[index]);
        if (Number.isFinite(amount)) zonePrices.set(zone, amount);
      });
      return {
        forwarder: row[iForwarder].trim(),
        originCountry: row[iOrigin].trim(),
        destCountry: row[iDest].trim(),
        from: parseNumberDE(row[iFrom]),
        to: parseNumberDE(row[iTo]),
        unit: row[iUnit].trim(),
        zonePrices,
      };
    })
    .filter((row) => Number.isFinite(row.from) && Number.isFinite(row.to));

  STATE.forwarders = Array.from(new Set(STATE.rates.map((row) => row.forwarder))).sort((a, b) => a.localeCompare(b, "de"));
}

async function loadFloaterConfig() {
  try {
    const response = await fetch("floater.json", { cache: "no-store" });
    if (!response.ok) throw new Error("floater.json fehlt");
    const payload = await response.json();
    STATE.floaterConfig = Object.fromEntries(
      Object.entries(payload || {}).map(([key, value]) => [normalizeKey(key), Number(value)]),
    );
  } catch {
    STATE.floaterConfig = {};
  }
}

function getForwarderRows(forwarder, destCountry, loadMeters) {
  return STATE.rates.filter((row) => (
    normalizeKey(row.forwarder) === normalizeKey(forwarder)
    && row.originCountry === ORIGIN_COUNTRY
    && row.destCountry === destCountry
    && loadMeters >= row.from
    && loadMeters <= row.to
    && normalizeKey(row.unit) !== "minimum"
  ));
}

function findZone(forwarder, destCountry, postalCode) {
  const zoneMode = getZoneMode(forwarder);
  const postalValue = Number.parseInt(String(postalCode).replace(/\D/g, ""), 10);
  if (!Number.isFinite(postalValue)) return null;

  const matches = STATE.zones.filter((row) => (
    row.forwarder === zoneMode
    && row.originCountry === ORIGIN_COUNTRY
    && row.destCountry === destCountry
    && postalValue >= row.from
    && postalValue <= row.to
  ));

  if (!matches.length) return null;
  matches.sort((a, b) => (a.to - a.from) - (b.to - b.from));
  return { zone: matches[0].zone, zoneMode, matchedRow: matches[0] };
}

function findRate(forwarder, destCountry, loadMeters, zone) {
  const rows = getForwarderRows(forwarder, destCountry, loadMeters);
  if (!rows.length) return null;

  rows.sort((a, b) => (a.to - a.from) - (b.to - b.from));
  const rateRow = rows[0];
  const basePrice = rateRow.zonePrices.get(zone);
  if (!Number.isFinite(basePrice)) return { rateRow, basePrice: null };
  return { rateRow, basePrice };
}

function validateInput({ forwarder, destCountry, postalCode, loadMeters }) {
  if (!forwarder) return "Bitte Dienstleister wählen.";
  if (!destCountry) return "Bitte Land wählen.";
  if (!postalCode || String(postalCode).trim().length < 3) return "Bitte eine gültige PLZ eingeben.";
  if (!(loadMeters > 0)) return "Lademeter muss größer 0 sein.";
  return null;
}

function formatBand(row) {
  return `${String(row.from).replace('.', ',')} bis ${String(row.to).replace('.', ',')} ${row.unit || ""}`.trim();
}

function buildDebugPayload(input, zoneResult, rateResult, floaterPercent, total) {
  return {
    input,
    zoneMode: zoneResult?.zoneMode ?? null,
    zoneMatch: zoneResult?.matchedRow ?? null,
    foundZone: zoneResult?.zone ?? null,
    rateBand: rateResult?.rateRow ? {
      forwarder: rateResult.rateRow.forwarder,
      originCountry: rateResult.rateRow.originCountry,
      destCountry: rateResult.rateRow.destCountry,
      from: rateResult.rateRow.from,
      to: rateResult.rateRow.to,
      unit: rateResult.rateRow.unit,
    } : null,
    basePrice: rateResult?.basePrice ?? null,
    floaterPercent,
    total,
  };
}

function downloadText(filename, text, mimeType = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mimeType });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function initCalculatorPage() {
  const form = document.getElementById("calculatorForm");
  if (!form) return;

  const forwarderSelect = document.getElementById("forwarder");
  const countrySelect = document.getElementById("destCountry");
  const postalInput = document.getElementById("postalCode");
  const loadMetersInput = document.getElementById("loadMeters");
  const floaterInput = document.getElementById("dieselFloater");
  const messageBox = document.getElementById("messageBox");
  const resultBox = document.getElementById("resultBox");
  const debugPre = document.getElementById("debugPre");
  const exportBtn = document.getElementById("exportDebug");

  STATE.forwarders.forEach((forwarder) => {
    const option = document.createElement("option");
    option.value = forwarder;
    option.textContent = forwarder;
    forwarderSelect.appendChild(option);
  });

  const countries = Array.from(new Set(STATE.rates.filter((row) => row.originCountry === ORIGIN_COUNTRY).map((row) => row.destCountry))).sort();
  countries.forEach((country) => {
    const option = document.createElement("option");
    option.value = country;
    option.textContent = country;
    countrySelect.appendChild(option);
  });

  function showMessage(text, kind = "warn") {
    messageBox.textContent = text;
    messageBox.className = `notice ${kind}`;
    messageBox.style.display = text ? "block" : "none";
  }

  function fillDefaultFloater() {
    const forwarder = forwarderSelect.value;
    floaterInput.value = getFloaterPercent(forwarder).toString().replace('.', ',');
  }

  forwarderSelect.addEventListener("change", fillDefaultFloater);
  fillDefaultFloater();

  let latestDebug = null;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = {
      forwarder: forwarderSelect.value,
      destCountry: countrySelect.value,
      postalCode: postalInput.value.trim(),
      loadMeters: parseNumberDE(loadMetersInput.value),
      floaterPercent: parseNumberDE(floaterInput.value),
    };

    const validationError = validateInput(input);
    if (validationError) {
      showMessage(validationError, "danger");
      resultBox.style.display = "none";
      debugPre.textContent = "";
      latestDebug = null;
      return;
    }

    const zoneResult = findZone(input.forwarder, input.destCountry, input.postalCode);
    if (!zoneResult) {
      showMessage(`Keine Zone gefunden für ${input.destCountry} / ${input.postalCode}.`, "danger");
      resultBox.style.display = "none";
      debugPre.textContent = "";
      latestDebug = null;
      return;
    }

    const rateResult = findRate(input.forwarder, input.destCountry, input.loadMeters, zoneResult.zone);
    if (!rateResult) {
      showMessage(`Kein Tarifband gefunden für ${input.forwarder}, ${input.destCountry} und ${String(input.loadMeters).replace('.', ',')} Lademeter.`, "danger");
      resultBox.style.display = "none";
      debugPre.textContent = "";
      latestDebug = null;
      return;
    }

    if (!Number.isFinite(rateResult.basePrice)) {
      showMessage(`Für Zone ${zoneResult.zone} existiert im gewählten Tarifband kein Preis.`, "danger");
      resultBox.style.display = "none";
      debugPre.textContent = "";
      latestDebug = null;
      return;
    }

    const floaterPercent = Number.isFinite(input.floaterPercent) ? input.floaterPercent : 0;
    const floaterAmount = round2(rateResult.basePrice * (floaterPercent / 100));
    const total = round2(rateResult.basePrice + floaterAmount);

    document.getElementById("metricZone").textContent = String(zoneResult.zone);
    document.getElementById("metricZoneMode").textContent = zoneResult.zoneMode;
    document.getElementById("metricBase").textContent = money(rateResult.basePrice);
    document.getElementById("metricBand").textContent = formatBand(rateResult.rateRow);
    document.getElementById("metricFloater").textContent = `${floaterPercent.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;
    document.getElementById("metricFloaterAmount").textContent = money(floaterAmount);
    document.getElementById("metricTotal").textContent = money(total);
    document.getElementById("metricForwarder").textContent = input.forwarder;

    showMessage("Berechnung erfolgreich durchgeführt.", "success");
    resultBox.style.display = "block";

    latestDebug = buildDebugPayload(input, zoneResult, rateResult, floaterPercent, total);
    debugPre.textContent = JSON.stringify(latestDebug, null, 2);
  });

  exportBtn.addEventListener("click", () => {
    if (!latestDebug) return;
    downloadText("trocellen_debug.json", JSON.stringify(latestDebug, null, 2), "application/json;charset=utf-8");
  });
}

function initFloaterPage() {
  const textarea = document.getElementById("floaterEditor");
  if (!textarea) return;

  const saveBtn = document.getElementById("saveFloaterFile");
  const resetBtn = document.getElementById("resetFloaterFile");
  const info = document.getElementById("floaterInfo");

  const payload = {};
  STATE.forwarders.forEach((forwarder) => {
    payload[forwarder] = getFloaterPercent(forwarder);
  });
  textarea.value = JSON.stringify(payload, null, 2);

  saveBtn.addEventListener("click", () => {
    try {
      const parsed = JSON.parse(textarea.value);
      downloadText("floater.json", JSON.stringify(parsed, null, 2), "application/json;charset=utf-8");
      info.textContent = "Neue floater.json wurde heruntergeladen.";
      info.className = "notice success";
      info.style.display = "block";
    } catch (error) {
      info.textContent = `JSON ungültig: ${error.message}`;
      info.className = "notice danger";
      info.style.display = "block";
    }
  });

  resetBtn.addEventListener("click", () => {
    textarea.value = JSON.stringify(payload, null, 2);
    info.style.display = "none";
  });
}

async function boot() {
  await Promise.all([loadZones(), loadRates(), loadFloaterConfig()]);
  STATE.ready = true;
  initCalculatorPage();
  initFloaterPage();
}

window.addEventListener("DOMContentLoaded", () => {
  boot().catch((error) => {
    const el = document.getElementById("fatalError");
    if (el) {
      el.textContent = `Fehler beim Laden der Daten: ${error.message}`;
      el.style.display = "block";
      el.className = "notice danger";
    } else {
      alert(`Fehler beim Laden der Daten: ${error.message}`);
    }
    console.error(error);
  });
});
