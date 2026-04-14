const ORIGIN_COUNTRY = "DE";
const DEFAULT_ZONE_MODE = "ALL";

const STATE = {
  rates: [],
  zones: [],
  floaterConfig: {},
  forwarders: [],
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

function normalizePostal(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .trim();
}

function parseNumberDE(value) {
  if (value == null) return NaN;
  const raw = String(value).trim();
  if (!raw) return NaN;
  return Number(raw.replace(/\./g, "").replace(/,/g, "."));
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("de-DE", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function money(value) {
  return Number.isFinite(value) ? `${formatNumber(value, 2)} €` : "—";
}

function percent(value) {
  return Number.isFinite(value) ? `${formatNumber(value, 2)} %` : "0,00 %";
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
    ";": (sample.match(/;/g) || []).length,
    "\t": (sample.match(/\t/g) || []).length,
    ",": (sample.match(/,/g) || []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] || ";";
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

function detectZoneColumns(headers) {
  const columns = [];
  headers.forEach((header, index) => {
    const match = String(header).trim().match(/^zone\s*(\d+)$/i);
    if (match) columns.push({ index, zone: Number(match[1]) });
  });
  return columns;
}

function getZoneMode(forwarder) {
  return ZONE_MODE_BY_FORWARDER[normalizeKey(forwarder)] || DEFAULT_ZONE_MODE;
}

function getFloaterPercent(forwarder) {
  const key = normalizeKey(forwarder);
  const value = STATE.floaterConfig[key];
  return Number.isFinite(value) ? value : 0;
}

function isNumericZoneValue(value) {
  return /^\d+$/.test(String(value ?? "").trim());
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
    .map((row) => {
      const fromRaw = String(row[iFrom] ?? "").trim();
      const toRaw = String(row[iTo] ?? "").trim();
      return {
        forwarder: String(row[iForwarder] ?? "").trim(),
        originCountry: String(row[iOrigin] ?? "").trim(),
        destCountry: String(row[iDest] ?? "").trim(),
        fromNorm: normalizePostal(fromRaw),
        toNorm: normalizePostal(toRaw),
        numericFrom: isNumericZoneValue(fromRaw) ? Number.parseInt(fromRaw, 10) : null,
        numericTo: isNumericZoneValue(toRaw) ? Number.parseInt(toRaw, 10) : null,
        zone: Number.parseInt(String(row[iZone]).trim(), 10),
      };
    })
    .filter((row) => Number.isFinite(row.zone));
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
        forwarder: String(row[iForwarder] ?? "").trim(),
        originCountry: String(row[iOrigin] ?? "").trim(),
        destCountry: String(row[iDest] ?? "").trim(),
        from: parseNumberDE(row[iFrom]),
        to: parseNumberDE(row[iTo]),
        unit: String(row[iUnit] ?? "").trim(),
        zonePrices,
      };
    })
    .filter((row) => Number.isFinite(row.from) && Number.isFinite(row.to));

  STATE.forwarders = Array.from(new Set(
    STATE.rates
      .filter((row) => row.originCountry === ORIGIN_COUNTRY)
      .map((row) => row.forwarder),
  )).sort((a, b) => a.localeCompare(b, "de"));
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

function postalMatchesZone(zoneRow, postalCode) {
  const postalNorm = normalizePostal(postalCode);
  if (!postalNorm) return false;

  if (zoneRow.numericFrom != null && zoneRow.numericTo != null) {
    const digits = postalNorm.replace(/\D/g, "");
    if (!digits) return false;
    const postalValue = Number.parseInt(digits, 10);
    return Number.isFinite(postalValue)
      && postalValue >= zoneRow.numericFrom
      && postalValue <= zoneRow.numericTo;
  }

  if (!zoneRow.fromNorm) return false;

  if (zoneRow.fromNorm === zoneRow.toNorm) {
    return postalNorm.startsWith(zoneRow.fromNorm);
  }

  return postalNorm >= zoneRow.fromNorm && postalNorm <= zoneRow.toNorm;
}

function findZone(forwarder, destCountry, postalCode) {
  const zoneMode = getZoneMode(forwarder);
  const matches = STATE.zones.filter((row) => (
    normalizeKey(row.forwarder) === normalizeKey(zoneMode)
    && row.originCountry === ORIGIN_COUNTRY
    && row.destCountry === destCountry
    && postalMatchesZone(row, postalCode)
  ));

  if (!matches.length) return null;

  matches.sort((a, b) => {
    const aLen = a.fromNorm.length;
    const bLen = b.fromNorm.length;
    if (bLen !== aLen) return bLen - aLen;
    const aWidth = (a.numericTo ?? 0) - (a.numericFrom ?? 0);
    const bWidth = (b.numericTo ?? 0) - (b.numericFrom ?? 0);
    return aWidth - bWidth;
  });

  return {
    zone: matches[0].zone,
    zoneMode,
  };
}

function diagnoseNoResults(destCountry, postalCode, loadMeters) {
  const zoneHits = [];
  const tariffHits = [];

  STATE.forwarders.forEach((forwarder) => {
    const zoneResult = findZone(forwarder, destCountry, postalCode);
    if (zoneResult) {
      zoneHits.push({ forwarder, zone: zoneResult.zone });
      const rateResult = findRate(forwarder, destCountry, loadMeters, zoneResult.zone);
      if (rateResult && Number.isFinite(rateResult.appliedBasePrice)) {
        tariffHits.push(forwarder);
      }
    }
  });

  if (!zoneHits.length) {
    return `Keine Zone gefunden. Für ${destCountry} ist die PLZ ${postalCode} in der zones.csv aktuell nicht abgedeckt.`;
  }
  if (!tariffHits.length) {
    return `Zone gefunden (${zoneHits[0].zone}), aber kein passendes Tarifband in rates.csv für ${String(loadMeters).replace('.', ',')} Lademeter.`;
  }
  return "Für diese Kombination wurde kein berechenbarer Dienstleister gefunden.";
}

function getRateRows(forwarder, destCountry, loadMeters) {
  return STATE.rates.filter((row) => (
    normalizeKey(row.forwarder) === normalizeKey(forwarder)
    && row.originCountry === ORIGIN_COUNTRY
    && row.destCountry === destCountry
    && loadMeters >= row.from
    && loadMeters <= row.to
  ));
}

function getMinimumRow(forwarder, destCountry, loadMeters) {
  const minimumRows = getRateRows(forwarder, destCountry, loadMeters)
    .filter((row) => normalizeKey(row.unit) === "minimum");

  if (!minimumRows.length) return null;
  minimumRows.sort((a, b) => (a.to - a.from) - (b.to - b.from));
  return minimumRows[0];
}

function findRate(forwarder, destCountry, loadMeters, zone) {
  const tariffRows = getRateRows(forwarder, destCountry, loadMeters)
    .filter((row) => normalizeKey(row.unit) !== "minimum");

  if (!tariffRows.length) return null;

  tariffRows.sort((a, b) => (a.to - a.from) - (b.to - b.from));
  const rateRow = tariffRows[0];
  const tariffPrice = rateRow.zonePrices.get(zone);

  if (!Number.isFinite(tariffPrice)) {
    return {
      rateRow,
      minimumRow: null,
      tariffPrice: null,
      minimumPrice: null,
      appliedBasePrice: null,
      priceSource: null,
    };
  }

  const minimumRow = getMinimumRow(forwarder, destCountry, loadMeters);
  const minimumPrice = minimumRow ? minimumRow.zonePrices.get(zone) : null;
  const appliedBasePrice = Number.isFinite(minimumPrice)
    ? Math.max(tariffPrice, minimumPrice)
    : tariffPrice;

  let priceSource = "Tarif";
  if (Number.isFinite(minimumPrice) && minimumPrice > tariffPrice) priceSource = "Minimum";
  if (Number.isFinite(minimumPrice) && minimumPrice === tariffPrice) priceSource = "Tarif / Minimum gleich";

  return {
    rateRow,
    minimumRow,
    tariffPrice,
    minimumPrice,
    appliedBasePrice,
    priceSource,
  };
}

function validateInput({ destCountry, postalCode, loadMeters }) {
  if (!destCountry) return "Bitte zuerst ein Land wählen.";
  if (!postalCode || String(postalCode).trim().length < 2) return "Bitte eine gültige PLZ eingeben.";
  if (!(loadMeters > 0)) return "Lademeter muss größer 0 sein.";
  return null;
}

function buildCalculationForForwarder(forwarder, destCountry, postalCode, loadMeters) {
  const zoneResult = findZone(forwarder, destCountry, postalCode);
  if (!zoneResult) {
    return { forwarder, success: false, reason: "Keine Zone gefunden." };
  }

  const rateResult = findRate(forwarder, destCountry, loadMeters, zoneResult.zone);
  if (!rateResult) {
    return { forwarder, success: false, reason: "Kein Tarifband gefunden." };
  }

  if (!Number.isFinite(rateResult.appliedBasePrice)) {
    return { forwarder, success: false, reason: `Kein Preis für Zone ${zoneResult.zone} im Tarifband.` };
  }

  const floaterPercent = getFloaterPercent(forwarder);
  const floaterAmount = round2(rateResult.appliedBasePrice * (floaterPercent / 100));
  const total = round2(rateResult.appliedBasePrice + floaterAmount);

  return {
    forwarder,
    success: true,
    zone: zoneResult.zone,
    zoneMode: zoneResult.zoneMode,
    basePrice: rateResult.appliedBasePrice,
    floaterPercent,
    floaterAmount,
    total,
    priceSource: rateResult.priceSource,
  };
}

function renderEmptyRow(text = "Noch keine Berechnung.") {
  const tbody = document.getElementById("resultsBody");
  if (!tbody) return;
  tbody.innerHTML = `<tr id="noResults"><td colspan="7" class="muted">${text}</td></tr>`;
}

function renderResults(results) {
  const tbody = document.getElementById("resultsBody");
  if (!tbody) return;

  tbody.innerHTML = "";

  if (!results.length) {
    renderEmptyRow("Keine berechenbaren Ergebnisse gefunden.");
    return;
  }

  results.forEach((result, index) => {
    const tr = document.createElement("tr");
    if (index === 0) tr.className = "best-row";
    tr.innerHTML = `
      <td>${index === 0 ? '<span class="rank-badge">Günstigster</span>' : ''}<span class="provider-name">${result.forwarder}</span></td>
      <td>${result.zone}</td>
      <td class="right">${money(result.basePrice)}</td>
      <td class="right">${percent(result.floaterPercent)}</td>
      <td class="right">${money(result.floaterAmount)}</td>
      <td class="right total-strong">${money(result.total)}</td>
      <td class="meta-cell">${result.priceSource}</td>
    `;
    tbody.appendChild(tr);
  });
}

function initCalculatorPage() {
  const form = document.getElementById("calculatorForm");
  if (!form) return;

  const countrySelect = document.getElementById("destCountry");
  const postalInput = document.getElementById("postalCode");
  const loadMetersInput = document.getElementById("loadMeters");
  const messageBox = document.getElementById("messageBox");
  const summaryBox = document.getElementById("summaryBox");
  const resultsSection = document.getElementById("resultsSection");

  const countries = Array.from(new Set(
    STATE.rates
      .filter((row) => row.originCountry === ORIGIN_COUNTRY)
      .map((row) => row.destCountry),
  )).sort();

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

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const input = {
      destCountry: countrySelect.value,
      postalCode: postalInput.value.trim(),
      loadMeters: parseNumberDE(loadMetersInput.value),
    };

    const validationError = validateInput(input);
    if (validationError) {
      showMessage(validationError, "danger");
      resultsSection.style.display = "none";
      summaryBox.style.display = "none";
      renderEmptyRow();
      return;
    }

    const successfulResults = [];
    const errors = [];

    STATE.forwarders.forEach((forwarder) => {
      const result = buildCalculationForForwarder(forwarder, input.destCountry, input.postalCode, input.loadMeters);
      if (result.success) successfulResults.push(result);
      else errors.push(`${forwarder}: ${result.reason}`);
    });

    successfulResults.sort((a, b) => a.total - b.total || a.forwarder.localeCompare(b.forwarder, "de"));

    if (!successfulResults.length) {
      showMessage(diagnoseNoResults(input.destCountry, input.postalCode, input.loadMeters), "danger");
      resultsSection.style.display = "none";
      summaryBox.style.display = "none";
      renderEmptyRow();
      return;
    }

    renderResults(successfulResults);

    const cheapest = successfulResults[0];
    document.getElementById("summaryCountry").textContent = input.destCountry;
    document.getElementById("summaryPostal").textContent = input.postalCode;
    document.getElementById("summaryLdm").textContent = String(input.loadMeters).replace('.', ',');
    document.getElementById("summaryCount").textContent = String(successfulResults.length);
    document.getElementById("summaryBest").textContent = `${cheapest.forwarder} (${money(cheapest.total)})`;

    summaryBox.style.display = "grid";
    resultsSection.style.display = "block";

    if (errors.length) {
      showMessage(`Berechnung erfolgreich. ${successfulResults.length} Dienstleister gefunden, ${errors.length} ohne Ergebnis.`, "success");
    } else {
      showMessage(`Berechnung erfolgreich. ${successfulResults.length} Dienstleister gefunden.`, "success");
    }
  });

  form.addEventListener("reset", () => {
    setTimeout(() => {
      showMessage("", "warn");
      summaryBox.style.display = "none";
      resultsSection.style.display = "none";
      renderEmptyRow();
    }, 0);
  });
}

async function boot() {
  await Promise.all([loadZones(), loadRates(), loadFloaterConfig()]);
  initCalculatorPage();
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
