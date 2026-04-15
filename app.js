const ORIGIN_COUNTRY = "DE";
const DEFAULT_ZONE_MODE = "ALL";
const PRICE_SENTINEL = 99999;

const STATE = {
  rates: [],
  zones: [],
  floaterConfig: {},
  forwarders: [],
};

const ZONE_MODE_BY_FORWARDER = {
  morrisson: "Morrisson",
};

const SHIPMENT_TYPES = {
  teilladung: { label: "Teilladung", fixedLdm: null },
  ftl: { label: "FTL", fixedLdm: 13.6 },
  mega: { label: "Mega", fixedLdm: 13.7 },
  jumbo: { label: "Jumbo", fixedLdm: 15.0 },
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

function parseNumberFlexible(value) {
  if (value == null) return NaN;
  const raw = String(value).trim();
  if (!raw) return NaN;

  const cleaned = raw.replace(/\s+/g, "");
  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");

  if (hasComma && hasDot) {
    return Number(cleaned.replace(/\./g, "").replace(/,/g, "."));
  }
  if (hasComma) {
    return Number(cleaned.replace(/,/g, "."));
  }
  if (hasDot) {
    const parts = cleaned.split(".");
    if (parts.length === 2 && parts[1].length <= 2) return Number(cleaned);
    return Number(cleaned.replace(/\./g, ""));
  }
  return Number(cleaned);
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
        const amount = parseNumberFlexible(row[index]);
        if (Number.isFinite(amount)) zonePrices.set(zone, amount);
      });

      return {
        forwarder: String(row[iForwarder] ?? "").trim(),
        originCountry: String(row[iOrigin] ?? "").trim(),
        destCountry: String(row[iDest] ?? "").trim(),
        from: parseNumberFlexible(row[iFrom]),
        to: parseNumberFlexible(row[iTo]),
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
  const text = await fetchTextSmart("floater.json");
  const data = JSON.parse(text);
  const normalized = {};
  Object.entries(data || {}).forEach(([key, value]) => {
    const num = Number(value);
    normalized[normalizeKey(key)] = Number.isFinite(num) ? num : 0;
  });
  STATE.floaterConfig = normalized;
}

function postalMatchesZone(row, postalCode) {
  const postal = normalizePostal(postalCode);
  if (!postal) return false;

  if (row.numericFrom != null && row.numericTo != null && /^\d+$/.test(postal)) {
    const postalNum = Number.parseInt(postal, 10);
    return postalNum >= row.numericFrom && postalNum <= row.numericTo;
  }

  const from = row.fromNorm;
  const to = row.toNorm;
  if (!from || !to) return false;

  if (from === to) return postal.startsWith(from);

  if (from.length === to.length && postal.length >= from.length) {
    const prefix = postal.slice(0, from.length);
    return prefix >= from && prefix <= to;
  }

  return postal >= from && postal <= to;
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

function isPlaceholderPrice(value) {
  return Number.isFinite(value) && value >= PRICE_SENTINEL;
}

function findRate(forwarder, destCountry, loadMeters, zone) {
  const tariffRows = getRateRows(forwarder, destCountry, loadMeters)
    .filter((row) => normalizeKey(row.unit) !== "minimum");

  if (!tariffRows.length) return null;

  tariffRows.sort((a, b) => (a.to - b.to) || (a.from - b.from));
  const rateRow = tariffRows[0];
  const tariffPrice = rateRow.zonePrices.get(zone);

  if (!Number.isFinite(tariffPrice) || isPlaceholderPrice(tariffPrice)) {
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
  const minimumPriceRaw = minimumRow ? minimumRow.zonePrices.get(zone) : null;
  const minimumPrice = Number.isFinite(minimumPriceRaw) && !isPlaceholderPrice(minimumPriceRaw)
    ? minimumPriceRaw
    : null;

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

function getSelectedShipmentType() {
  const selected = document.querySelector('input[name="shipmentType"]:checked');
  return selected?.value || "teilladung";
}

function getEffectiveLoadMeters(shipmentType, loadMetersInput) {
  const config = SHIPMENT_TYPES[shipmentType] || SHIPMENT_TYPES.teilladung;
  if (config.fixedLdm != null) return config.fixedLdm;
  return parseNumberFlexible(loadMetersInput);
}

function validateInput({ destCountry, postalCode, shipmentType, loadMeters }) {
  if (!destCountry) return "Bitte zuerst ein Land wählen.";
  if (!postalCode || String(postalCode).trim().length < 2) return "Bitte eine gültige PLZ eingeben.";
  if (!SHIPMENT_TYPES[shipmentType]) return "Bitte eine Transportart wählen.";
  if (shipmentType === "teilladung" && !(loadMeters > 0)) return "Bei Teilladung muss Lademeter größer 0 sein.";
  return null;
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
    return { forwarder, success: false, reason: `Kein gültiger Preis für Zone ${zoneResult.zone} im Tarifband.` };
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

function updateTransportUi() {
  const shipmentType = getSelectedShipmentType();
  const loadMetersField = document.getElementById("loadMetersField");
  const summaryLdmRow = document.getElementById("summaryLdmRow");

  document.querySelectorAll(".transport-option").forEach((el) => {
    const input = el.querySelector("input");
    el.classList.toggle("active", !!input?.checked);
  });

  if (loadMetersField) {
    loadMetersField.style.display = shipmentType === "teilladung" ? "grid" : "none";
  }
  if (summaryLdmRow) {
    summaryLdmRow.style.display = shipmentType === "teilladung" ? "block" : "none";
  }
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
  const transportSwitch = document.getElementById("transportSwitch");

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

  transportSwitch?.addEventListener("change", updateTransportUi);
  updateTransportUi();

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const shipmentType = getSelectedShipmentType();
    const effectiveLoadMeters = getEffectiveLoadMeters(shipmentType, loadMetersInput.value);
    const input = {
      destCountry: countrySelect.value,
      postalCode: postalInput.value.trim(),
      shipmentType,
      loadMeters: effectiveLoadMeters,
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
    const shipmentLabel = SHIPMENT_TYPES[shipmentType]?.label || "—";
    document.getElementById("summaryCountry").textContent = input.destCountry;
    document.getElementById("summaryPostal").textContent = input.postalCode;
    document.getElementById("summaryShipmentType").textContent = shipmentLabel;
    document.getElementById("summaryLdm").textContent = String(input.loadMeters).replace('.', ',');
    document.getElementById("summaryCount").textContent = String(successfulResults.length);
    document.getElementById("summaryBest").textContent = `${cheapest.forwarder} (${money(cheapest.total)})`;

    updateTransportUi();
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
      const teilladungRadio = document.querySelector('input[name="shipmentType"][value="teilladung"]');
      if (teilladungRadio) teilladungRadio.checked = true;
      updateTransportUi();
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
