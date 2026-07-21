const FIELD_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*$/;
const STARTS_WITH_NUMBER_PATTERN = /^[0-9]/;
const RESERVED_CHARS_PATTERN = /[[\]{}:'"]/;
const MAX_FIELDS = 30;
const MAX_TABLE_COLUMNS = 10;
const MAX_TABLE_ROWS = 50;
const RESTORE_PREFIX = "docsai-evals:";
const PAGE_STORAGE_KEY = "docsai-evals:active-page";
const VALID_PAGES = ["dashboard", "run", "history", "reports", "settings"];
const progressMessages = [
  "Fetching run output...",
  "Comparing fields...",
  "Running LLM judge...",
  "Analysing failures...",
  "Generating report...",
];

const state = {
  reports: [],
  reportCache: new Map(),
  extractedFields: {},
  fieldMetadata: {},
  documentType: "",
  latestReport: null,
  currentRunReport: null,
  activeModalReport: null,
  activeFieldFilter: "all",
  sortByF1: false,
  f1SortDirection: "desc",
  historyPage: 1,
  historyPageSize: 6,
  progressTimer: null,
  schemaDoctypes: [],
  activeSchemaDoctype: "",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const els = {
  pages: $$(".page"),
  navItems: $$(".nav-item"),

  dashboardError: $("#dashboard-error"),
  statTotalRuns: $("#stat-total-runs"),
  statAverageF1: $("#stat-average-f1"),
  statPromptProblems: $("#stat-prompt-problems"),
  statOcrLimitations: $("#stat-ocr-limitations"),
  dashboardHealthBadge: $("#dashboard-health-badge"),
  latestRunLabel: $("#latest-run-label"),
  latestPrecision: $("#latest-precision"),
  latestRecall: $("#latest-recall"),
  latestF1: $("#latest-f1"),
  latestMissing: $("#latest-missing"),
  recentReportsBody: $("#recent-reports-body"),

  evalForm: $("#eval-form"),
  runId: $("#run-id-input"),
  loadFieldsButton: $("#load-fields-button"),
  runFieldsBanner: $("#run-fields-banner"),
  restorePrompt: $("#restore-prompt"),
  restoreYes: $("#restore-yes"),
  restoreNo: $("#restore-no"),
  detectedPanel: $("#detected-panel"),
  detectedDocType: $("#detected-doc-type"),
  detectedFieldCount: $("#detected-field-count"),
  extractedHints: $("#extracted-hints"),
  extractedFieldPills: $("#extracted-field-pills"),
  fieldRows: $("#field-rows"),
  runMessageBanner: $("#run-message-banner"),
  progressIndicator: $("#progress-indicator"),
  progressText: $("#progress-text"),
  runButton: $("#run-eval-button"),
  runStatusBadge: $("#run-status-badge"),

  schemaImportInput: $("#schema-import-input"),
  schemaImportParseButton: $("#schema-import-parse-button"),
  schemaImportError: $("#schema-import-error"),
  schemaImportDoctypes: $("#schema-import-doctypes"),
  schemaImportGenerated: $("#schema-import-generated"),

  sideTabs: $$("[data-side-tab]"),
  sidePanels: $$("[data-side-panel]"),
  jsonPreviewDocTypeHead: $("#json-preview-doctype-head"),
  jsonPreviewDocType: $("#json-preview-doctype"),
  jsonPreviewCopyButton: $("#json-preview-copy-button"),
  jsonPreviewOutput: $("#json-preview-output"),
  jsonPreviewEmpty: $("#json-preview-empty"),

  resultSubtitle: $("#result-subtitle"),
  resultStatusBadge: $("#result-status-badge"),
  resultF1: $("#result-f1"),
  resultPassed: $("#result-passed"),
  resultFailed: $("#result-failed"),
  resultMissing: $("#result-missing"),
  resultUncertain: $("#result-uncertain"),
  resultInsights: $("#result-insights"),
  resultPromptProblems: $("#result-prompt-problems"),
  resultOcrLimitations: $("#result-ocr-limitations"),
  openReportButton: $("#open-report-button"),

  historySearch: $("#history-search"),
  refreshReportsButton: $("#refresh-reports-button"),
  historyBanner: $("#history-banner"),
  historyCount: $("#history-count"),
  historyBody: $("#history-body"),
  sortF1Button: $("#sort-f1-button"),
  sortF1Indicator: $("#sort-f1-indicator"),
  historyPrev: $("#history-prev"),
  historyNext: $("#history-next"),
  historyPageLabel: $("#history-page-label"),

  refreshHealthButton: $("#refresh-health-button"),
  healthBanner: $("#health-banner"),
  healthStatusDot: $("#health-status-dot"),
  healthStatusText: $("#health-status-text"),
  healthApiBase: $("#health-api-base"),
  healthResultsPath: $("#health-results-path"),
  healthAzureOpenai: $("#health-azure-openai"),

  toast: $("#toast"),

  reportModal: $("#report-modal"),
  modalCloseButton: $("#modal-close-button"),
  modalFilename: $("#modal-filename"),
  modalTitle: $("#modal-title"),
  modalRunId: $("#modal-run-id"),
  modalDocType: $("#modal-doc-type"),
  modalF1: $("#modal-f1"),
  modalPrecision: $("#modal-precision"),
  modalRecall: $("#modal-recall"),
  tabs: $$(".tab"),
  tabPanels: $$(".tab-panel"),
  modalLegacyNote: $("#modal-legacy-note"),
  modalLegacyData: $("#modal-legacy-data"),
  modalInsights: $("#modal-insights"),
  modalActions: $("#modal-actions"),
  modalDownloadButton: $("#modal-download-button"),
  modalFieldFilters: $("#modal-field-filters"),
  modalFieldDetails: $("#modal-field-details"),
};

const api = {
  async request(path, options = {}) {
    const response = await fetch(path, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload.detail || `Request failed with HTTP ${response.status}`;
      let message = typeof detail === "string" ? detail : detail.message || `Request failed with HTTP ${response.status}`;
      if (detail.field && detail.message) message = `${detail.field}: ${detail.message}`;
      const error = new Error(message);
      error.status = response.status;
      error.detail = detail;
      throw error;
    }
    return payload;
  },
  health() {
    return this.request("/api/health");
  },
  summary() {
    return this.request("/api/evaluations/summary");
  },
  reports() {
    return this.request("/api/evaluations/reports");
  },
  report(name) {
    return this.request(`/api/evaluations/reports/${encodeURIComponent(name)}`);
  },
  deleteReport(name) {
    return this.request(`/api/evaluations/reports/${encodeURIComponent(name)}`, { method: "DELETE" });
  },
  runFields(runId) {
    return this.request(`/api/run/${encodeURIComponent(runId)}/fields`);
  },
  runEvaluation(body) {
    return this.request("/api/evaluations/run/full", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },
};

/* ---------- Small shared helpers ---------- */

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setText(element, value) {
  if (element) element.textContent = value;
}

function setBanner(element, message, type = "error") {
  if (!element) return;
  element.textContent = message;
  element.className = `banner banner--${type}`;
}

function clearBanner(element) {
  if (!element) return;
  element.textContent = "";
  element.className = "banner hidden";
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  window.setTimeout(() => els.toast.classList.remove("show"), 2800);
}

function setButtonLoading(button, isLoading, label) {
  if (!button) return;
  if (!button.dataset.label) button.dataset.label = button.textContent.trim();
  button.disabled = isLoading;
  button.textContent = isLoading ? label : button.dataset.label;
}

function formatScore(value) {
  if (value === null || value === undefined || value === "") return "-";
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return "-";
  const percentage = numericValue <= 1 ? numericValue * 100 : numericValue;
  return `${percentage.toFixed(1)}%`;
}

function f1ScoreClass(value) {
  const numericValue = Number(value || 0);
  const percentage = numericValue <= 1 ? numericValue * 100 : numericValue;
  if (percentage >= 80) return "score-good";
  if (percentage >= 60) return "score-mid";
  return "score-bad";
}

function formatTimestamp(value) {
  if (!value) return "-";
  const compact = String(value).match(/^(\d{8})_(\d{6})$/);
  if (compact) {
    const [, datePart, timePart] = compact;
    return `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)} ${timePart.slice(0, 2)}:${timePart.slice(2, 4)}`;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return String(value);
  return new Date(parsed).toLocaleString();
}

function reportName(report) {
  return report.report_name || report.report_filename || report.name || "";
}

function shortRunId(report) {
  const value = String(report.run_id || report.filename || reportName(report) || "-");
  return value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-5)}` : value;
}

function reportRunTime(report) {
  const modified = Number(report.modified || 0);
  if (modified) return modified;
  const parsed = Date.parse(report.timestamp || "");
  return Number.isNaN(parsed) ? 0 : parsed / 1000;
}

function scoresFor(report) {
  if (report.f1_scores) return report.f1_scores;
  if (report.evals_report) return report.evals_report;
  if (report.combined) return report.combined;
  if (report.llm_eval?.f1_scores) return report.llm_eval.f1_scores;
  return {};
}

function fieldsFor(report) {
  if (report.field_comparison) return report.field_comparison;
  if (report.llm_eval?.field_comparison) return report.llm_eval.field_comparison;
  return {};
}

function summaryFor(report) {
  const summary = report.summary || {};
  const scores = scoresFor(report);
  return {
    passed: summary.passed ?? scores.tp ?? 0,
    failed: summary.failed ?? scores.fp ?? 0,
    missing: summary.missing ?? scores.fn ?? 0,
    promptProblems: summary.prompt_problems ?? countOcrVerdict(report, "PROMPT_PROBLEM"),
    ocrLimitations: summary.ocr_limitations ?? countOcrVerdict(report, "OCR_LIMITATION"),
    uncertain:
      summary.uncertain_unresolved ??
      countStatuses(report, ["GREY", "GREY_UNRESOLVED"]) + countOcrVerdict(report, "UNCERTAIN"),
  };
}

function countStatuses(report, statuses) {
  const wanted = new Set(statuses);
  return Object.values(fieldsFor(report)).filter((field) => wanted.has(String(field?.status || ""))).length;
}

function countOcrVerdict(report, verdict) {
  return Object.values(fieldsFor(report)).filter((field) => field?.ocr_search?.verdict === verdict).length;
}

function reportFormat(report) {
  if (report && report.field_comparison) return "new";
  if (report && report.ocr_eval) return "legacy";
  return "unknown";
}

/* ---------- Status/badge mapping ---------- */

function fieldRowModifier(status) {
  const normalized = String(status || "").toUpperCase();
  if (["TP", "PASS"].includes(normalized)) return "tp";
  if (["FP", "FAIL", "EXTRA", "PARTIAL"].includes(normalized)) return "fp";
  if (["FN", "MISSING"].includes(normalized)) return "fn";
  return "grey";
}

function statusBadgeClass(status) {
  const normalized = String(status || "").toUpperCase();
  if (["TP", "PASS"].includes(normalized)) return "success";
  if (["FP", "FAIL", "EXTRA"].includes(normalized)) return "error";
  if (["FN", "MISSING", "PARTIAL"].includes(normalized)) return "warning";
  return "muted";
}

function statusLabel(status) {
  const normalized = String(status || "").toUpperCase();
  if (normalized === "TP") return "PASS";
  if (normalized === "FP") return "FAIL";
  if (normalized === "FN") return "MISSING";
  if (normalized === "GREY" || normalized === "GREY_UNRESOLVED") return "UNCERTAIN";
  if (normalized === "EXTRA_INFO") return "EXTRA INFO";
  if (normalized === "PARTIAL") return "PARTIAL";
  if (normalized === "PRESENT" || normalized === "ABSENT") return normalized;
  return normalized || "PARTIAL";
}

function statusBadge(status) {
  return `<span class="badge badge--${statusBadgeClass(status)}">${escapeHtml(statusLabel(status))}</span>`;
}

function fieldGroup(status) {
  const normalized = String(status || "").toUpperCase();
  if (normalized === "TP") return "passed";
  if (["FP", "EXTRA", "PARTIAL"].includes(normalized)) return "failed";
  if (normalized === "FN") return "missing";
  return "uncertain";
}

/* ---------- Navigation ---------- */

function showPage(pageName) {
  const target = VALID_PAGES.includes(pageName) ? pageName : "dashboard";
  els.pages.forEach((page) => {
    const name = page.id.replace("page-", "");
    page.classList.toggle("hidden", name !== target);
  });
  els.navItems.forEach((item) => item.classList.toggle("nav-item--active", item.dataset.page === target));
  sessionStorage.setItem(PAGE_STORAGE_KEY, target);
}

function restoreActivePage() {
  showPage(sessionStorage.getItem(PAGE_STORAGE_KEY));
}

function wireNavigation() {
  els.navItems.forEach((button) => {
    button.addEventListener("click", () => showPage(button.dataset.page));
  });
  $$("[data-nav]").forEach((button) => {
    button.addEventListener("click", () => showPage(button.dataset.nav));
  });
}

/* ---------- Field entry: shared ---------- */

function entryNodes() {
  return $$(".field-row, .table-block");
}

function entryCount() {
  return entryNodes().length;
}

function ensureEntryLimit() {
  if (entryCount() >= MAX_FIELDS) {
    showToast("Maximum 30 fields per evaluation");
    return false;
  }
  return true;
}

function validateNameInput(input, errorElement = null, message = "camelCase only — no underscores or spaces", showError = true) {
  const value = input.value.trim();
  const isEmpty = value === "";
  const isValid = FIELD_NAME_PATTERN.test(value);
  let displayMessage = message;
  if (!isEmpty && !isValid) {
    if (STARTS_WITH_NUMBER_PATTERN.test(value)) {
      displayMessage = "Field name cannot start with a number";
    } else if (RESERVED_CHARS_PATTERN.test(value)) {
      displayMessage = "Field name cannot contain [ ] { } : or quotes";
    }
  }
  input.classList.toggle("is-invalid", !isEmpty && !isValid);
  input.title = !isEmpty && !isValid ? displayMessage : "";
  if (errorElement) {
    errorElement.textContent = displayMessage;
    errorElement.hidden = !showError || isEmpty || isValid;
  }
  return { value, isEmpty, isValid };
}

function autoGrowTextarea(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.max(textarea.scrollHeight, 60)}px`;
}

function removeEntry(entry) {
  entry.remove();
  if (!entryNodes().length) createFieldRow("simple");
  updateRunButtonState();
}

function entryHasContent(entry) {
  if (entry.classList.contains("table-block")) {
    return Boolean(
      entry.querySelector("[data-field-name]").value.trim()
        || tableColumns(entry).some(Boolean)
        || tableRows(entry).flat().some(Boolean),
    );
  }
  return Boolean(
    entry.querySelector("[data-field-name]").value.trim()
      || entry.querySelector("[data-field-value]").value.trim(),
  );
}

function hasSubmittableEntry() {
  return entryNodes().some((entry) => {
    const name = entry.querySelector("[data-field-name]").value.trim();
    return FIELD_NAME_PATTERN.test(name);
  });
}

function updateRunButtonState() {
  const hasRunId = els.runId.value.trim().length > 0;
  entryNodes().forEach((entry) => {
    validateNameInput(entry.querySelector("[data-field-name]"), null, undefined, false);
  });
  els.runButton.disabled = !(hasRunId && hasSubmittableEntry());
  $$("#add-field-chips .chip").forEach((chip) => {
    chip.disabled = entryCount() >= MAX_FIELDS;
  });
  renderJsonPreview();
}

/* ---------- Field entry: simple / multiline rows ---------- */

function valueControlHtml(isMultiline, value) {
  if (isMultiline) {
    return `<textarea class="field-value textarea-input" data-field-value placeholder="Enter multiline value...">${escapeHtml(value)}</textarea>`;
  }
  return `<input class="field-value text-input" data-field-value type="text" placeholder="expected value" value="${escapeHtml(value)}" />`;
}

function wireValueControl(control) {
  control.addEventListener("input", () => {
    if (control.tagName === "TEXTAREA") autoGrowTextarea(control);
    updateRunButtonState();
  });
  if (control.tagName === "TEXTAREA") autoGrowTextarea(control);
}

function toggleFieldRowType(row) {
  const wrap = row.querySelector(".field-value-wrap");
  const control = row.querySelector("[data-field-value]");
  const currentValue = control.value;
  const nextIsMultiline = row.dataset.entryType !== "multiline";
  row.dataset.entryType = nextIsMultiline ? "multiline" : "simple";
  const toggleButton = wrap.querySelector("[data-toggle-multiline]");
  control.remove();
  toggleButton.insertAdjacentHTML("beforebegin", valueControlHtml(nextIsMultiline, currentValue));
  const newControl = wrap.querySelector("[data-field-value]");
  wireValueControl(newControl);
  toggleButton.title = `Switch to ${nextIsMultiline ? "single line" : "multiline"}`;
  updateRunButtonState();
}

function createFieldRow(type = "simple", name = "", value = "") {
  if (!ensureEntryLimit()) return null;
  const isMultiline = type === "multiline";
  const row = document.createElement("div");
  row.className = "field-row";
  row.dataset.entryType = isMultiline ? "multiline" : "simple";
  row.innerHTML = `
    <input class="field-name text-input" data-field-name type="text" placeholder="fieldName" value="${escapeHtml(name)}" autocomplete="off" />
    <div class="field-value-wrap">
      ${valueControlHtml(isMultiline, value)}
      <button class="value-toggle" type="button" data-toggle-multiline title="Switch to ${isMultiline ? "single line" : "multiline"}">&#8597;</button>
    </div>
    <button class="remove-btn" type="button" data-remove title="Remove field">&times;</button>
  `;
  els.fieldRows.appendChild(row);
  const nameInput = row.querySelector("[data-field-name]");
  nameInput.addEventListener("input", () => {
    validateNameInput(nameInput);
    updateRunButtonState();
  });
  wireValueControl(row.querySelector("[data-field-value]"));
  row.querySelector("[data-toggle-multiline]").addEventListener("click", () => toggleFieldRowType(row));
  row.querySelector("[data-remove]").addEventListener("click", () => removeEntry(row));
  updateRunButtonState();
  return row;
}

/* ---------- Field entry: table blocks ---------- */

function tableColumns(block) {
  return Array.from(block.querySelectorAll("[data-column-name]")).map((input) => input.value.trim());
}

function tableRows(block) {
  return Array.from(block.querySelectorAll("[data-table-rows] tr")).map((row) => {
    return Array.from(row.querySelectorAll("[data-cell]")).map((input) => input.value.trim());
  });
}

function resizeColumnInput(input) {
  input.size = Math.max(input.value.length || input.placeholder.length, 6);
}

function rebuildTableRows(block, existingRows = tableRows(block)) {
  const columns = tableColumns(block);
  const headerRow = block.querySelector("[data-column-headers]");
  const rowsBody = block.querySelector("[data-table-rows]");
  headerRow.innerHTML = `${columns.map((column) => `<th>${escapeHtml(column || "Column")}</th>`).join("")}<th></th>`;
  rowsBody.innerHTML = "";
  existingRows.forEach((rowValues) => addTableDataRow(block, rowValues, false));
  const addRowButton = block.querySelector("[data-add-row]");
  addRowButton.disabled = columns.length === 0 || tableRows(block).length >= MAX_TABLE_ROWS;
}

function addTableColumn(block, columnName = "") {
  const columnsContainer = block.querySelector("[data-columns]");
  if (columnsContainer.querySelectorAll("[data-column-name]").length >= MAX_TABLE_COLUMNS) {
    showToast("Maximum 10 columns per table");
    return;
  }
  const existingRows = tableRows(block);
  const pill = document.createElement("span");
  pill.className = "col-pill";
  pill.innerHTML = `
    <input class="col-pill__input" data-column-name type="text" placeholder="columnName" value="${escapeHtml(columnName)}" />
    <button class="col-pill__remove" type="button" title="Remove column">&times;</button>
  `;
  columnsContainer.appendChild(pill);
  const input = pill.querySelector("[data-column-name]");
  resizeColumnInput(input);
  input.addEventListener("input", () => {
    const result = validateNameInput(input, null, undefined, false);
    pill.classList.toggle("is-invalid", !result.isEmpty && !result.isValid);
    resizeColumnInput(input);
    rebuildTableRows(block);
    updateRunButtonState();
  });
  pill.querySelector(".col-pill__remove").addEventListener("click", () => {
    const columnIndex = Array.from(columnsContainer.children).indexOf(pill);
    const currentRows = tableRows(block);
    pill.remove();
    const adjustedRows = currentRows.map((row) => row.filter((_cell, index) => index !== columnIndex));
    rebuildTableRows(block, adjustedRows);
    updateRunButtonState();
  });
  rebuildTableRows(block, existingRows);
  updateRunButtonState();
}

function addTableDataRow(block, values = [], shouldUpdate = true) {
  const columns = tableColumns(block);
  if (!columns.length) {
    showToast("Add at least one column first");
    return;
  }
  if (tableRows(block).length >= MAX_TABLE_ROWS) {
    showToast("Maximum 50 rows per table");
    return;
  }
  const row = document.createElement("tr");
  row.innerHTML = `
    ${columns
      .map((column, index) => `<td><input class="text-input" data-cell type="text" placeholder="${escapeHtml(column || "value")}" value="${escapeHtml(values[index] || "")}" /></td>`)
      .join("")}
    <td><button class="remove-btn" type="button" title="Remove row">&times;</button></td>
  `;
  block.querySelector("[data-table-rows]").appendChild(row);
  row.querySelectorAll("[data-cell]").forEach((input) => input.addEventListener("input", updateRunButtonState));
  row.querySelector("button").addEventListener("click", () => {
    row.remove();
    updateRunButtonState();
  });
  if (shouldUpdate) updateRunButtonState();
}

function createTableBlock(entry = {}) {
  if (!ensureEntryLimit()) return null;
  const block = document.createElement("div");
  block.className = "table-block";
  block.dataset.entryType = "table";
  block.innerHTML = `
    <div class="table-block__header">
      <span class="table-tag">TABLE</span>
      <input class="field-name text-input" data-field-name type="text" placeholder="lineItems" value="${escapeHtml(entry.fieldName || "")}" autocomplete="off" />
      <div class="table-block__spacer"></div>
      <button class="btn-add-column" type="button" data-add-column>+ add column</button>
      <button class="remove-btn" type="button" data-remove title="Remove table">&times;</button>
    </div>
    <div class="col-pill-row" data-columns></div>
    <table class="table-block__data">
      <thead><tr data-column-headers></tr></thead>
      <tbody data-table-rows></tbody>
    </table>
    <button class="add-row-link" type="button" data-add-row>+ add row</button>
  `;
  els.fieldRows.appendChild(block);
  const nameInput = block.querySelector("[data-field-name]");
  nameInput.addEventListener("input", () => {
    validateNameInput(nameInput);
    updateRunButtonState();
  });
  block.querySelector("[data-add-column]").addEventListener("click", () => addTableColumn(block));
  block.querySelector("[data-add-row]").addEventListener("click", () => addTableDataRow(block));
  block.querySelector("[data-remove]").addEventListener("click", () => removeEntry(block));
  (entry.columns || []).forEach((column) => addTableColumn(block, column));
  (entry.rows || []).forEach((row) => addTableDataRow(block, row, false));
  updateRunButtonState();
  return block;
}

function addEntryByType(type, data = {}) {
  const normalizedType = type === "text_block" ? "multiline" : type === "line_items" ? "table" : type;
  if (normalizedType === "multiline") {
    return createFieldRow("multiline", data.fieldName || data.name || "", data.value || "");
  }
  if (normalizedType === "table") {
    return createTableBlock(data);
  }
  return createFieldRow("simple", data.fieldName || data.name || "", data.value || "");
}

function wireAddFieldChips() {
  const chips = $$("#add-field-chips .chip");
  chips.forEach((chip) => {
    chip.addEventListener("click", () => {
      const type = chip.dataset.addType;
      if (type === "multiline") createFieldRow("multiline");
      else if (type === "table") createTableBlock();
      else createFieldRow("simple");
      chips.forEach((other) => other.classList.toggle("chip--active", other === chip));
    });
  });
}

/* ---------- Schema import ---------- */

const PLACEHOLDER_VALUE_PATTERN = /^(string|string or -|-|n\/a|na|null|none|)$/i;

function toCamelCase(key) {
  const words = String(key ?? "")
    .trim()
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  if (!words.length) return "";
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index === 0) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}

function isPlaceholderValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== "string") return false;
  return PLACEHOLDER_VALUE_PATTERN.test(value.trim());
}

function isFlatObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseDoctypeObject(fieldsObj) {
  const scalarFields = [];
  const tableFields = [];
  const skipped = [];
  Object.entries(fieldsObj).forEach(([rawKey, rawValue]) => {
    const fieldName = toCamelCase(rawKey);
    if (!fieldName || !FIELD_NAME_PATTERN.test(fieldName)) {
      skipped.push(rawKey);
      return;
    }
    if (Array.isArray(rawValue)) {
      const firstItem = rawValue.find((item) => isFlatObject(item));
      if (rawValue.length && !firstItem) {
        skipped.push(rawKey);
        return;
      }
      const columns = firstItem
        ? Object.keys(firstItem)
            .map(toCamelCase)
            .filter((column) => FIELD_NAME_PATTERN.test(column))
        : [];
      tableFields.push({ fieldName, columns });
      return;
    }
    if (isFlatObject(rawValue)) {
      skipped.push(rawKey);
      return;
    }
    scalarFields.push({ fieldName, value: isPlaceholderValue(rawValue) ? "" : String(rawValue) });
  });
  return { scalarFields, tableFields, skipped };
}

function parseSchemaTemplate(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error("Invalid JSON - check for missing commas, quotes, or brackets.");
  }
  if (!isFlatObject(parsed)) {
    throw new Error("Paste a JSON object, not an array or a plain value.");
  }

  const topEntries = Object.entries(parsed);
  if (!topEntries.length) {
    throw new Error("The pasted JSON has no fields.");
  }

  const allWrapped = topEntries.every(([, value]) => Array.isArray(value) && value.length && isFlatObject(value[0]));
  const skippedDoctypes = [];
  let doctypes;
  if (allWrapped) {
    doctypes = topEntries.map(([key, value]) => ({
      key: toCamelCase(key) || key,
      label: key,
      ...parseDoctypeObject(value[0]),
    }));
  } else {
    const hasNestedShape = topEntries.some(([, value]) => Array.isArray(value) && value.length && isFlatObject(value[0]));
    if (hasNestedShape) {
      throw new Error("Mix of plain fields and document-type arrays detected - paste either a single flat object or a JSON with one array-of-object per document type.");
    }
    doctypes = [{ key: "fields", label: "Fields", ...parseDoctypeObject(parsed) }];
  }

  doctypes.forEach((doctype) => skippedDoctypes.push(...doctype.skipped.map((key) => `${doctype.label}.${key}`)));
  if (!doctypes.some((doctype) => doctype.scalarFields.length || doctype.tableFields.length)) {
    throw new Error("No supported fields were found in the pasted JSON.");
  }

  return { doctypes, skippedDoctypes };
}

function captureSchemaSectionState() {
  const doctype = activeSchemaDoctypeData();
  if (!doctype) return;
  const section = els.schemaImportGenerated.querySelector(`[data-doctype-section="${cssEscape(doctype.key)}"]`);
  if (!section) return;

  doctype.scalarFields.forEach((field) => {
    const input = section.querySelector(`[data-schema-field="${cssEscape(field.fieldName)}"] [data-schema-value]`);
    if (input) field.value = input.value;
  });

  doctype.tableFields.forEach((tableField) => {
    const block = section.querySelector(`[data-schema-table="${cssEscape(tableField.fieldName)}"]`);
    if (!block) return;
    const rowNodes = Array.from(block.querySelectorAll("[data-schema-row]"));
    tableField.rows = rowNodes.map((rowNode) => {
      const row = {};
      tableField.columns.forEach((column) => {
        const cell = rowNode.querySelector(`[data-schema-cell="${cssEscape(column)}"]`);
        row[column] = cell ? cell.value : "";
      });
      return row;
    });
  });
}

function renderSchemaDoctypeTabs(doctypes) {
  els.schemaImportDoctypes.classList.toggle("hidden", doctypes.length <= 1);
  els.schemaImportDoctypes.innerHTML = doctypes
    .map(
      (doctype) =>
        `<button class="tab ${doctype.key === state.activeSchemaDoctype ? "tab--active" : ""}" type="button" data-schema-doctype="${escapeHtml(doctype.key)}">${escapeHtml(doctype.label)}</button>`,
    )
    .join("");
}

function renderSchemaSection(doctype) {
  const scalarRowsHtml = doctype.scalarFields
    .map(
      (field) => `
        <div class="schema-field-row" data-schema-field="${escapeHtml(field.fieldName)}">
          <input class="field-name text-input" type="text" value="${escapeHtml(field.fieldName)}" disabled />
          <div class="schema-field-value-wrap">
            <input class="field-value text-input" data-schema-value type="text" placeholder="expected value" value="${escapeHtml(field.value)}" />
          </div>
        </div>
      `,
    )
    .join("");

  const tableBlocksHtml = doctype.tableFields
    .map((tableField) => {
      const rowsHtml = tableField.rows
        .map(
          (row, rowIndex) => `
            <tr data-schema-row="${rowIndex}">
              ${tableField.columns
                .map(
                  (column) =>
                    `<td><input class="text-input" data-schema-cell="${escapeHtml(column)}" type="text" placeholder="${escapeHtml(column)}" value="${escapeHtml(row[column] || "")}" /></td>`,
                )
                .join("")}
              <td><button class="remove-btn" type="button" data-schema-remove-row title="Remove row">&times;</button></td>
            </tr>
          `,
        )
        .join("");
      return `
        <div class="schema-table-block" data-schema-table="${escapeHtml(tableField.fieldName)}">
          <div class="schema-table-block__header">
            <span class="table-tag">TABLE</span>
            <span>${escapeHtml(tableField.fieldName)}</span>
          </div>
          <table class="table-block__data">
            <thead><tr>${tableField.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}<th></th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
          <button class="add-row-link" type="button" data-schema-add-row>+ add row</button>
        </div>
      `;
    })
    .join("");

  return `
    <div class="schema-doctype-section" data-doctype-section="${escapeHtml(doctype.key)}">
      <div class="schema-fields">${scalarRowsHtml}</div>
      ${tableBlocksHtml}
    </div>
  `;
}

function renderSchemaSections() {
  els.schemaImportGenerated.classList.toggle("hidden", !state.schemaDoctypes.length);
  els.schemaImportGenerated.innerHTML = state.schemaDoctypes.map(renderSchemaSection).join("");
  state.schemaDoctypes.forEach((doctype) => {
    const section = els.schemaImportGenerated.querySelector(`[data-doctype-section="${cssEscape(doctype.key)}"]`);
    if (section) section.classList.toggle("hidden", doctype.key !== state.activeSchemaDoctype);
  });
}

function cssEscape(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function clearSchemaGeneratedEntries() {
  Array.from(els.fieldRows.querySelectorAll('[data-schema-generated="true"]')).forEach((node) => node.remove());
}

function activeSchemaDoctypeData() {
  return state.schemaDoctypes.find((doctype) => doctype.key === state.activeSchemaDoctype) || null;
}

function syncSchemaSectionToFieldRows() {
  captureSchemaSectionState();
  clearSchemaGeneratedEntries();
  const doctype = activeSchemaDoctypeData();
  if (!doctype) {
    updateRunButtonState();
    return;
  }

  doctype.scalarFields.forEach((field) => {
    const value = (field.value || "").trim();
    if (!value) return;
    const node = addEntryByType("simple", { fieldName: field.fieldName, value });
    if (node) node.dataset.schemaGenerated = "true";
  });

  doctype.tableFields.forEach((tableField) => {
    const rows = tableField.rows
      .map((row) => tableField.columns.map((column) => (row[column] || "").trim()))
      .filter((row) => row.some((cell) => cell !== ""));
    if (!rows.length) return;
    const node = addEntryByType("table", { fieldName: tableField.fieldName, columns: tableField.columns, rows });
    if (node) node.dataset.schemaGenerated = "true";
  });

  updateRunButtonState();
}

let schemaSyncTimer = null;
function scheduleSchemaSync() {
  if (schemaSyncTimer) window.clearTimeout(schemaSyncTimer);
  schemaSyncTimer = window.setTimeout(syncSchemaSectionToFieldRows, 250);
}

function setActiveSchemaDoctype(key) {
  captureSchemaSectionState();
  state.activeSchemaDoctype = key;
  renderSchemaDoctypeTabs(state.schemaDoctypes);
  Array.from(els.schemaImportGenerated.querySelectorAll("[data-doctype-section]")).forEach((section) => {
    section.classList.toggle("hidden", section.dataset.doctypeSection !== key);
  });
  syncSchemaSectionToFieldRows();
}

function handleParseSchema() {
  els.schemaImportError.classList.add("hidden");
  const rawText = els.schemaImportInput.value.trim();
  if (!rawText) {
    els.schemaImportError.textContent = "Paste a JSON schema first.";
    els.schemaImportError.classList.remove("hidden");
    return;
  }
  try {
    const { doctypes, skippedDoctypes } = parseSchemaTemplate(rawText);
    state.schemaDoctypes = doctypes.map((doctype) => ({
      ...doctype,
      tableFields: doctype.tableFields.map((field) => ({ ...field, rows: [] })),
    }));
    state.activeSchemaDoctype = doctypes[0].key;
    renderSchemaDoctypeTabs(state.schemaDoctypes);
    renderSchemaSections();
    syncJsonPreviewDocTypeVisibility();
    syncSchemaSectionToFieldRows();
    if (skippedDoctypes.length) {
      showToast(`Some fields were skipped (unsupported shape): ${skippedDoctypes.join(", ")}`);
    }
  } catch (error) {
    els.schemaImportError.textContent = error.message;
    els.schemaImportError.classList.remove("hidden");
  }
}

function wireSchemaImport() {
  els.schemaImportParseButton.addEventListener("click", handleParseSchema);
  els.schemaImportDoctypes.addEventListener("click", (event) => {
    const button = event.target.closest("[data-schema-doctype]");
    if (!button) return;
    setActiveSchemaDoctype(button.dataset.schemaDoctype);
  });
  els.schemaImportGenerated.addEventListener("input", (event) => {
    if (event.target.closest("[data-schema-value], [data-schema-cell]")) scheduleSchemaSync();
  });
  els.schemaImportGenerated.addEventListener("click", (event) => {
    const addRowButton = event.target.closest("[data-schema-add-row]");
    if (addRowButton) {
      captureSchemaSectionState();
      const block = addRowButton.closest("[data-schema-table]");
      const doctype = activeSchemaDoctypeData();
      const tableField = doctype?.tableFields.find((field) => field.fieldName === block.dataset.schemaTable);
      if (tableField && tableField.rows.length < MAX_TABLE_ROWS) {
        tableField.rows.push({});
        renderSchemaSections();
        syncSchemaSectionToFieldRows();
      } else if (tableField) {
        showToast("Maximum 50 rows per table");
      }
      return;
    }
    const removeRowButton = event.target.closest("[data-schema-remove-row]");
    if (removeRowButton) {
      captureSchemaSectionState();
      const row = removeRowButton.closest("[data-schema-row]");
      const block = removeRowButton.closest("[data-schema-table]");
      const doctype = activeSchemaDoctypeData();
      const tableField = doctype?.tableFields.find((field) => field.fieldName === block.dataset.schemaTable);
      if (tableField) {
        tableField.rows.splice(Number(row.dataset.schemaRow), 1);
        renderSchemaSections();
        syncSchemaSectionToFieldRows();
      }
    }
  });
}

/* ---------- Collect + validate golden fields ---------- */

function collectGoldenFields(showErrors = false) {
  const fields = {};
  const entries = [];
  const errors = [];
  const warnings = [];
  const names = new Set();

  entryNodes().forEach((entry) => {
    const isTable = entry.classList.contains("table-block");
    const type = isTable ? "table" : entry.dataset.entryType || "simple";
    const nameInput = entry.querySelector("[data-field-name]");
    const nameResult = validateNameInput(nameInput, null, undefined, showErrors);
    const name = nameResult.value;

    if (!name && type !== "table") return;
    if (!name && !entryHasContent(entry)) return;
    if (!name && entryHasContent(entry)) {
      errors.push("Field name is required for entries with values");
      return;
    }
    if (!nameResult.isValid) {
      errors.push(`${name || "Field name"} must be camelCase`);
      return;
    }
    if (names.has(name)) {
      errors.push(`Field name '${name}' is used more than once. Each field name must be unique.`);
      return;
    }
    names.add(name);

    if (type === "table") {
      const columns = tableColumns(entry);
      const validColumns = [];
      let hasColumnError = false;
      entry.querySelectorAll("[data-column-name]").forEach((input) => {
        const result = validateNameInput(input, null, undefined, showErrors);
        if (!result.isValid) hasColumnError = true;
        validColumns.push(result.value);
      });
      if (!columns.length) {
        errors.push(`Table '${name}' has no columns. Add at least one column before running evaluation.`);
        return;
      }
      if (hasColumnError) {
        errors.push(`${name}: column names must be camelCase`);
        return;
      }
      const rows = tableRows(entry).filter((row) => row.some((cell) => cell.trim() !== ""));
      if (!rows.length) {
        warnings.push(`Table ${name} has no rows - it will check only that the field exists in extraction output`);
      }
      fields[name] = rows.map((row) => Object.fromEntries(validColumns.map((column, index) => [column, row[index] || ""])));
      entries.push({ type: "table", fieldName: name, columns: validColumns, rows });
      return;
    }

    const value = entry.querySelector("[data-field-value]").value.trim();
    fields[name] = value;
    entries.push({ type, fieldName: name, value });
  });

  if (!entries.length) errors.push("Add at least one field to evaluate");
  return { fields, entries, errors, warnings, validCount: entries.length };
}

/* ---------- JSON preview ---------- */

function jsonPreviewDocTypeKey() {
  const result = validateNameInput(els.jsonPreviewDocType, null, undefined, false);
  return result.isValid && result.value ? result.value : "document";
}

function syncJsonPreviewDocTypeVisibility() {
  els.jsonPreviewDocTypeHead.classList.toggle("hidden", state.schemaDoctypes.length > 0);
}

function schemaDoctypeFieldsObject(doctype) {
  const fields = {};
  doctype.scalarFields.forEach((field) => {
    const value = (field.value || "").trim();
    if (value) fields[field.fieldName] = value;
  });
  doctype.tableFields.forEach((tableField) => {
    const rows = tableField.rows
      .map((row) => Object.fromEntries(tableField.columns.map((column) => [column, (row[column] || "").trim()])))
      .filter((row) => Object.values(row).some((cell) => cell !== ""));
    if (rows.length) fields[tableField.fieldName] = rows;
  });
  return fields;
}

function buildPreviewJson() {
  if (state.schemaDoctypes.length) {
    captureSchemaSectionState();
    const wrapped = {};
    state.schemaDoctypes.forEach((doctype) => {
      wrapped[doctype.key] = [schemaDoctypeFieldsObject(doctype)];
    });
    const activeFields = wrapped[state.activeSchemaDoctype]?.[0] || {};
    return { fields: activeFields, wrapped };
  }
  const { fields } = collectGoldenFields(false);
  const docTypeKey = jsonPreviewDocTypeKey();
  return { fields, wrapped: { [docTypeKey]: [fields] } };
}

function renderJsonPreview() {
  if (!els.jsonPreviewOutput) return;
  const { wrapped } = buildPreviewJson();
  const isEmpty = Object.values(wrapped).every((docs) => !Object.keys(docs[0] || {}).length);
  els.jsonPreviewOutput.classList.toggle("hidden", isEmpty);
  els.jsonPreviewEmpty.classList.toggle("hidden", !isEmpty);
  if (!isEmpty) els.jsonPreviewOutput.textContent = JSON.stringify(wrapped, null, 2);
}

/* ---------- Extracted field hints ---------- */

function renderExtractedHints(fields, metadata = {}) {
  const entries = Object.entries(fields || {});
  if (!entries.length) {
    setBanner(els.runFieldsBanner, "No fields detected in this run. The extraction step may not have produced output.", "error");
    els.extractedHints.classList.add("hidden");
    return;
  }
  els.extractedFieldPills.innerHTML = entries
    .map(([field, value]) => {
      const fieldMeta = metadata[field] || {};
      if (fieldMeta.field_value_type === "table") {
        const columns = fieldMeta.field_schema || [];
        return `
          <article class="table-hint-card">
            <strong>Line items detected: ${escapeHtml(field)}</strong>
            <span>${Number(fieldMeta.row_count || 0)} rows, columns: ${escapeHtml(columns.join(", ") || "-")}</span>
            <button class="btn btn--secondary btn--small" type="button" data-table-hint="${escapeHtml(field)}">Add as line items table</button>
          </article>
        `;
      }
      const type = fieldMeta.field_value_type === "text_block" ? "text_block" : "simple";
      const title = typeof value === "string" ? value : JSON.stringify(value);
      return `<button class="field-pill" type="button" data-field="${escapeHtml(field)}" data-entry-type="${type}" title="${escapeHtml(title)}">${escapeHtml(field)}</button>`;
    })
    .join("");
  els.extractedHints.classList.remove("hidden");
  els.extractedHints.open = true;
}

/* ---------- Session storage restore ---------- */

function restoreStorageKey() {
  const runId = els.runId.value.trim();
  return runId ? `${RESTORE_PREFIX}${runId}` : "";
}

function maybeOfferRestore() {
  const key = restoreStorageKey();
  els.restorePrompt.classList.toggle("hidden", !(key && sessionStorage.getItem(key)));
}

function saveSessionFields(runId, fields) {
  sessionStorage.setItem(`${RESTORE_PREFIX}${runId}`, JSON.stringify(fields));
}

function restoreSessionFields() {
  const key = restoreStorageKey();
  if (!key) return;
  const raw = sessionStorage.getItem(key);
  if (!raw) return;
  try {
    const savedEntries = JSON.parse(raw);
    els.fieldRows.innerHTML = "";
    let restoredCount = 0;
    if (Array.isArray(savedEntries)) {
      savedEntries.forEach((entry) => {
        try {
          addEntryByType(entry.type || "simple", entry);
          restoredCount += 1;
        } catch (error) {
          console.error("Skipping field entry that failed to restore from session storage:", entry, error);
        }
      });
    } else {
      Object.entries(savedEntries).forEach(([field, value]) => {
        try {
          createFieldRow("simple", field, value);
          restoredCount += 1;
        } catch (error) {
          console.error("Skipping field entry that failed to restore from session storage:", field, error);
        }
      });
    }
    if (!restoredCount) createFieldRow("simple");
    els.restorePrompt.classList.add("hidden");
    showToast("Previous values restored");
  } catch (error) {
    console.error("Failed to restore session fields:", error);
    sessionStorage.removeItem(key);
  }
}

/* ---------- Run evaluation flow ---------- */

async function loadRunFields() {
  const runId = els.runId.value.trim();
  clearBanner(els.runFieldsBanner);
  if (!runId) {
    setBanner(els.runFieldsBanner, "Enter a DocsAI Run ID first.", "error");
    return;
  }
  setButtonLoading(els.loadFieldsButton, true, "Loading...");
  try {
    const payload = await api.runFields(runId);
    state.extractedFields = payload.extracted_fields || {};
    state.fieldMetadata = payload.field_metadata || {};
    state.documentType = payload.document_type || "unknown";
    setText(els.detectedDocType, state.documentType);
    setText(els.detectedFieldCount, payload.field_count ?? Object.keys(state.extractedFields).length);
    els.detectedPanel.classList.remove("hidden");
    renderExtractedHints(state.extractedFields, state.fieldMetadata);
    if (!els.jsonPreviewDocType.value.trim() && FIELD_NAME_PATTERN.test(state.documentType)) {
      els.jsonPreviewDocType.value = state.documentType;
    }
    renderJsonPreview();
    if (payload.extraction_warning) {
      setBanner(
        els.runFieldsBanner,
        "Fields loaded via heuristic step detection. Verify these are the correct extraction fields before running eval.",
        "warning",
      );
    } else {
      const message = payload.warning ? `Loaded fields. ${payload.warning}` : "Run fields loaded.";
      setBanner(els.runFieldsBanner, message, "success");
    }
  } catch (error) {
    state.extractedFields = {};
    state.fieldMetadata = {};
    state.documentType = "";
    els.detectedPanel.classList.add("hidden");
    els.extractedHints.classList.add("hidden");
    setBanner(els.runFieldsBanner, error.message, "error");
  } finally {
    setButtonLoading(els.loadFieldsButton, false);
    maybeOfferRestore();
    updateRunButtonState();
  }
}

function startProgressMessages() {
  let index = 0;
  els.progressIndicator.classList.remove("hidden");
  els.progressText.textContent = progressMessages[index];
  state.progressTimer = window.setInterval(() => {
    index = Math.min(index + 1, progressMessages.length - 1);
    els.progressText.textContent = progressMessages[index];
  }, 1800);
}

function stopProgressMessages() {
  if (state.progressTimer) window.clearInterval(state.progressTimer);
  state.progressTimer = null;
  els.progressIndicator.classList.add("hidden");
}

function rememberCurrentRun(report) {
  state.currentRunReport = report;
  state.latestReport = report;
  const name = reportName(report);
  if (name) state.reportCache.set(name, report);
}

function insightRow(icon, tone, text) {
  return `<div class="insight-row insight-row--${tone}"><span class="ti ${icon}"></span><span>${escapeHtml(text)}</span></div>`;
}

function generateInsights(report) {
  const scores = scoresFor(report);
  const fields = fieldsFor(report);
  const insights = [];
  if (report.multiple_documents_warning) {
    const documentCount = Number(report.document_count || 0);
    insights.push({
      icon: "ti-alert-triangle",
      tone: "warning",
      text: `This run contains ${documentCount} document objects. Only the first was evaluated. If this document has an original and amendment, results may reflect the original only.`,
    });
  }
  if (Number(scores.f1 || 0) >= 0.9) {
    insights.push({ icon: "ti-circle-check", tone: "success", text: "Extraction is performing well for these fields" });
  }
  Object.entries(fields).forEach(([field, result]) => {
    const verdict = result?.ocr_search?.verdict;
    if (verdict === "PROMPT_PROBLEM") {
      insights.push({
        icon: "ti-alert-triangle",
        tone: "danger",
        text: `${field} is in the document but was not extracted correctly. Tune the extraction prompt.`,
      });
    }
    if (verdict === "OCR_LIMITATION") {
      insights.push({
        icon: "ti-alert-triangle",
        tone: "danger",
        text: `${field} was not read by OCR. Prompt tuning will not fix this.`,
      });
    }
  });
  const hasLlmError = Object.values(fields).some((result) => result?.llm_judge?.llm_error || result?.ocr_search?.llm_error);
  if (hasLlmError) {
    insights.push({
      icon: "ti-help-circle",
      tone: "warning",
      text: "Some fields could not be automatically diagnosed. Check the field details for more context.",
    });
  }
  if (!insights.length) {
    insights.push({ icon: "ti-circle-check", tone: "success", text: "No diagnostic issues were found for the entered fields" });
  }
  return insights;
}

function renderResultInsights(report) {
  els.resultInsights.innerHTML = generateInsights(report).map((item) => insightRow(item.icon, item.tone, item.text)).join("");
}

function setResultStatus(text, tone) {
  els.resultStatusBadge.textContent = text;
  els.resultStatusBadge.className = `badge badge--${tone}`;
}

function renderRunResult(report) {
  const scores = scoresFor(report);
  const summary = summaryFor(report);
  setText(els.resultSubtitle, reportName(report) || "Evaluation completed");
  setText(els.resultF1, formatScore(scores.f1));
  setText(els.resultPassed, summary.passed);
  setText(els.resultFailed, summary.failed);
  setText(els.resultMissing, summary.missing);
  setText(els.resultUncertain, summary.uncertain);
  setText(els.resultPromptProblems, summary.promptProblems);
  setText(els.resultOcrLimitations, summary.ocrLimitations);
  renderResultInsights(report);
  els.openReportButton.disabled = false;
  setSideTab("result");
}

async function runEvaluation(event) {
  event.preventDefault();
  clearBanner(els.runMessageBanner);
  const { fields, entries, errors, warnings } = collectGoldenFields(true);
  if (!els.runId.value.trim()) {
    setBanner(els.runMessageBanner, "Enter a DocsAI Run ID before running evaluation.", "error");
    return;
  }
  if (errors.length) {
    setBanner(els.runMessageBanner, errors.join(" | "), "error");
    return;
  }
  if (warnings.length) setBanner(els.runMessageBanner, warnings.join(" | "), "warning");
  setResultStatus("RUNNING", "warning");
  setButtonLoading(els.runButton, true, "Running evaluation...");
  startProgressMessages();
  try {
    const runId = els.runId.value.trim();
    const report = await api.runEvaluation({ run_id: runId, golden_fields: fields });
    saveSessionFields(runId, entries);
    rememberCurrentRun(report);
    renderRunResult(report);
    renderLatest(report);
    setResultStatus("COMPLETE", "success");
    if (!warnings.length) setBanner(els.runMessageBanner, "Evaluation completed successfully.", "success");
    await Promise.all([loadSummary(), loadReports()]);
    openReportModal(report);
  } catch (error) {
    setResultStatus("FAILED", "error");
    setBanner(els.runMessageBanner, error.message, "error");
  } finally {
    stopProgressMessages();
    setButtonLoading(els.runButton, false);
    updateRunButtonState();
  }
}

/* ---------- Dashboard ---------- */

function reportActionButtons(name) {
  const safeName = escapeHtml(name);
  return `
    <div class="row-actions">
      <button class="icon-btn" type="button" data-action="view" data-report="${safeName}" title="View report" aria-label="View report">
        <span class="ti ti-eye"></span>
      </button>
      <button class="text-btn text-btn--danger" type="button" data-action="delete" data-report="${safeName}">del</button>
    </div>
  `;
}

function renderRecentReports() {
  const reports = state.reports.slice(0, 5);
  if (!reports.length) {
    els.recentReportsBody.innerHTML = '<tr><td colspan="7" class="empty-row">No reports yet</td></tr>';
    return;
  }
  els.recentReportsBody.innerHTML = reports
    .map((report) => {
      const scores = scoresFor(report);
      const summary = summaryFor(report);
      return `
        <tr>
          <td title="${escapeHtml(report.run_id || "")}">${escapeHtml(shortRunId(report))}</td>
          <td>${escapeHtml(report.document_type || "unknown")}</td>
          <td class="${f1ScoreClass(scores.f1)}">${formatScore(scores.f1)}</td>
          <td class="value-passed">${summary.passed}</td>
          <td class="value-failed">${summary.failed}</td>
          <td class="value-missing">${summary.missing}</td>
          <td>${reportActionButtons(reportName(report))}</td>
        </tr>
      `;
    })
    .join("");
}

function renderLatest(report) {
  if (!report) {
    setText(els.latestRunLabel, "No report selected");
    setText(els.latestPrecision, "-");
    setText(els.latestRecall, "-");
    setText(els.latestF1, "-");
    setText(els.latestMissing, "-");
    return;
  }
  const scores = scoresFor(report);
  const summary = summaryFor(report);
  setText(els.latestRunLabel, report.run_id || reportName(report));
  setText(els.latestPrecision, formatScore(scores.precision));
  setText(els.latestRecall, formatScore(scores.recall));
  setText(els.latestF1, formatScore(scores.f1));
  setText(els.latestMissing, summary.missing);
}

async function loadHealth() {
  clearBanner(els.healthBanner);
  setText(els.healthApiBase, window.location.origin);
  try {
    const health = await api.health();
    els.healthStatusDot.className = "status-dot status-dot--ok";
    setText(els.healthStatusText, "ok");
    els.dashboardHealthBadge.textContent = "CONNECTED";
    els.dashboardHealthBadge.className = "badge badge--success";
    els.runStatusBadge.textContent = "READY";
    els.runStatusBadge.className = "badge badge--success";
    setText(els.healthResultsPath, String(Boolean(health.results_configured)));
    setText(els.healthAzureOpenai, String(Boolean(health.azure_openai_configured)));
  } catch (error) {
    els.healthStatusDot.className = "status-dot status-dot--error";
    setText(els.healthStatusText, "error");
    els.dashboardHealthBadge.textContent = "FAILED";
    els.dashboardHealthBadge.className = "badge badge--error";
    els.runStatusBadge.textContent = "DISCONNECTED";
    els.runStatusBadge.className = "badge badge--error";
    setBanner(els.healthBanner, error.message, "error");
  }
}

async function loadSummary() {
  clearBanner(els.dashboardError);
  try {
    const summary = await api.summary();
    setText(els.statTotalRuns, summary.total_runs ?? 0);
    setText(els.statAverageF1, formatScore(summary.average_f1));
    setText(els.statPromptProblems, summary.total_prompt_problems ?? 0);
    setText(els.statOcrLimitations, summary.total_ocr_limitations ?? 0);
  } catch (error) {
    setBanner(els.dashboardError, error.message, "error");
  }
}

async function loadReports() {
  clearBanner(els.historyBanner);
  try {
    const payload = await api.reports();
    state.reports = (payload.reports || []).sort((a, b) => reportRunTime(b) - reportRunTime(a));
    state.reports.forEach((report) => state.reportCache.set(report.name, report));
    state.latestReport = state.reports[0] || state.latestReport;
    renderLatest(state.latestReport);
    renderRecentReports();
    renderHistory();
  } catch (error) {
    setBanner(els.historyBanner, error.message, "error");
  }
}

async function refreshAll() {
  await Promise.all([loadHealth(), loadSummary(), loadReports()]);
}

async function getReport(name) {
  if (state.reportCache.has(name)) {
    const cached = state.reportCache.get(name);
    if (cached?.field_comparison || cached?.ocr_eval || cached?.llm_eval) return cached;
  }
  const report = await api.report(name);
  report.name = name;
  state.reportCache.set(name, report);
  return report;
}

/* ---------- History ---------- */

function rowForReport(report) {
  const scores = scoresFor(report);
  const summary = summaryFor(report);
  return `
    <tr>
      <td title="${escapeHtml(report.run_id || "")}">${escapeHtml(shortRunId(report))}</td>
      <td>${escapeHtml(report.document_type || "unknown")}</td>
      <td class="${f1ScoreClass(scores.f1)}">${formatScore(scores.f1)}</td>
      <td class="value-passed">${summary.passed}</td>
      <td class="value-failed">${summary.failed}</td>
      <td class="value-missing">${summary.missing}</td>
      <td>${escapeHtml(formatTimestamp(report.timestamp))}</td>
      <td>
        <button class="icon-btn" type="button" data-action="view" data-report="${escapeHtml(reportName(report))}" title="View report" aria-label="View report">
          <span class="ti ti-eye"></span>
        </button>
      </td>
      <td>
        <button class="text-btn text-btn--danger" type="button" data-action="delete" data-report="${escapeHtml(reportName(report))}">del</button>
      </td>
    </tr>
  `;
}

function filteredHistoryReports() {
  const query = els.historySearch.value.trim().toLowerCase();
  let reports = state.reports;
  if (query) {
    reports = reports.filter((report) => {
      return [reportName(report), report.run_id, report.filename, report.document_type]
        .some((value) => String(value || "").toLowerCase().includes(query));
    });
  }
  if (state.sortByF1) {
    reports = [...reports].sort((a, b) => {
      const aScore = Number(scoresFor(a).f1 || 0);
      const bScore = Number(scoresFor(b).f1 || 0);
      return state.f1SortDirection === "desc" ? bScore - aScore : aScore - bScore;
    });
  }
  return reports;
}

function renderHistory() {
  const reports = filteredHistoryReports();
  setText(els.historyCount, `${reports.length} report${reports.length === 1 ? "" : "s"}`);
  const totalPages = Math.max(1, Math.ceil(reports.length / state.historyPageSize));
  state.historyPage = Math.min(state.historyPage, totalPages);
  setText(els.historyPageLabel, `Page ${state.historyPage} of ${totalPages}`);
  els.historyPrev.disabled = state.historyPage <= 1;
  els.historyNext.disabled = state.historyPage >= totalPages;
  if (!reports.length) {
    els.historyBody.innerHTML = '<tr><td colspan="9" class="empty-row">No reports found</td></tr>';
    return;
  }
  const start = (state.historyPage - 1) * state.historyPageSize;
  els.historyBody.innerHTML = reports.slice(start, start + state.historyPageSize).map(rowForReport).join("");
}

async function handleReportAction(event) {
  const button = event.target.closest("[data-action][data-report]");
  if (!button) return;
  const name = button.dataset.report;
  if (button.dataset.action === "delete") {
    if (!window.confirm(`Delete report ${name}?`)) return;
    try {
      await api.deleteReport(name);
      state.reportCache.delete(name);
      showToast("Report deleted");
      await Promise.all([loadReports(), loadSummary()]);
    } catch (error) {
      setBanner(els.historyBanner, error.message, "error");
      showToast(error.message);
    }
    return;
  }
  getReport(name)
    .then((report) => {
      state.latestReport = report;
      renderLatest(report);
      openReportModal(report);
    })
    .catch((error) => {
      setBanner(els.historyBanner, error.message, "error");
      showToast(error.message);
    });
}

function wireHistory() {
  els.historySearch.addEventListener("input", () => {
    state.historyPage = 1;
    renderHistory();
  });
  els.sortF1Button.addEventListener("click", () => {
    if (!state.sortByF1) {
      state.sortByF1 = true;
      state.f1SortDirection = "desc";
    } else {
      state.f1SortDirection = state.f1SortDirection === "asc" ? "desc" : "asc";
    }
    els.sortF1Indicator.textContent = state.f1SortDirection === "desc" ? "↓" : "↑";
    state.historyPage = 1;
    renderHistory();
  });
  els.historyPrev.addEventListener("click", () => {
    state.historyPage = Math.max(1, state.historyPage - 1);
    renderHistory();
  });
  els.historyNext.addEventListener("click", () => {
    state.historyPage += 1;
    renderHistory();
  });
  els.refreshReportsButton.addEventListener("click", async () => {
    setButtonLoading(els.refreshReportsButton, true, "Refreshing...");
    await Promise.all([loadReports(), loadSummary()]);
    setButtonLoading(els.refreshReportsButton, false);
  });
  els.historyBody.addEventListener("click", handleReportAction);
  els.recentReportsBody.addEventListener("click", handleReportAction);
}

/* ---------- Report modal ---------- */

function setModalTab(tabName) {
  els.tabs.forEach((tab) => tab.classList.toggle("tab--active", tab.dataset.tab === tabName));
  els.tabPanels.forEach((panel) => panel.classList.toggle("tab-panel--active", panel.dataset.panel === tabName));
}

function severityForAction(action) {
  const text = `${action.field || ""} ${action.action || ""}`.toLowerCase();
  if (text.includes("prompt")) return { label: "PROMPT FIX", badgeClass: "badge--prompt-fix", order: 0 };
  if (text.includes("ocr")) return { label: "OCR LIMIT", badgeClass: "badge--ocr-limit", order: 1 };
  return { label: "INVESTIGATE", badgeClass: "badge--warning", order: 2 };
}

function renderModalActions(report) {
  const actions = [...(report.recommended_actions || [])].sort((a, b) => severityForAction(a).order - severityForAction(b).order);
  if (!actions.length) {
    els.modalActions.innerHTML = '<div class="empty-inline">No recommended actions for this report.</div>';
    return;
  }
  els.modalActions.innerHTML = actions
    .map((action) => {
      const severity = severityForAction(action);
      return `
        <article class="action-card">
          <div>
            <div class="action-card__field">${escapeHtml(action.field)}</div>
            <p class="action-card__text">${escapeHtml(action.action)}</p>
          </div>
          <span class="badge ${severity.badgeClass}">${escapeHtml(severity.label)}</span>
        </article>
      `;
    })
    .join("");
}

function renderModalFieldFilters(fields) {
  const entries = Object.values(fields);
  const counts = {
    all: entries.length,
    passed: entries.filter((item) => fieldGroup(item?.status) === "passed").length,
    failed: entries.filter((item) => fieldGroup(item?.status) === "failed").length,
    missing: entries.filter((item) => fieldGroup(item?.status) === "missing").length,
    uncertain: entries.filter((item) => fieldGroup(item?.status) === "uncertain").length,
  };
  if (state.activeFieldFilter === "all") {
    state.activeFieldFilter = counts.failed ? "failed" : "all";
  }
  const labels = [
    ["all", "All"],
    ["passed", "Passed"],
    ["failed", "Failed"],
    ["missing", "Missing"],
    ["uncertain", "Uncertain"],
  ];
  els.modalFieldFilters.innerHTML = labels
    .map(([key, label]) => {
      const activeClass = state.activeFieldFilter === key ? "filter-chip--active" : "";
      return `<button class="filter-chip ${activeClass}" type="button" data-field-filter="${key}">${label} (${counts[key]})</button>`;
    })
    .join("");
}

function formatFieldScore(result) {
  if (result.status === "FN" || result.score === null || result.score === undefined) return "-";
  if (["date", "numeric"].includes(String(result.field_type || ""))) return result.score === 100 ? "exact" : "0.0%";
  return `${Number(result.score || 0).toFixed(1)}%`;
}

function ocrActionHint(verdict) {
  if (verdict === "PROMPT_PROBLEM") {
    return '<div class="ocr-action-hint ocr-action-hint--prompt">Tune the extraction prompt for this field</div>';
  }
  if (verdict === "OCR_LIMITATION") {
    return "<div class=\"ocr-action-hint ocr-action-hint--ocr\">OCR did not capture this. Prompt tuning won't fix it.</div>";
  }
  return "";
}

function renderOcrAccordion(result) {
  const search = result.ocr_search;
  if (!search) return "";
  const verdict = String(search.verdict || "UNCERTAIN").toUpperCase();
  const verdictClass = verdict.toLowerCase();
  const badgeClass = verdict === "PROMPT_PROBLEM" ? "badge--warning" : verdict === "OCR_LIMITATION" ? "badge--error" : "badge--muted";
  const verdictLabel = verdict === "UNCERTAIN" ? "UNCERTAIN — needs manual review" : verdict.replaceAll("_", " ");
  return `
    <details class="ocr-accordion ocr-accordion--${verdictClass}">
      <summary>
        <span class="badge ${badgeClass}">${escapeHtml(verdictLabel)}</span>
        OCR diagnosis
      </summary>
      <p>${escapeHtml(search.reason || "-")}</p>
      <small>Found ${Number(search.occurrence_count || 0)} times in OCR markdown</small>
      ${ocrActionHint(verdict)}
    </details>
  `;
}

function lineItemColumns(result) {
  const rowResults = result.line_items?.row_results || [];
  if (rowResults[0]?.column_results) return Object.keys(rowResults[0].column_results);
  if (Array.isArray(result.golden_value) && result.golden_value[0]) return Object.keys(result.golden_value[0]);
  if (Array.isArray(result.extracted_value) && result.extracted_value[0]) return Object.keys(result.extracted_value[0]);
  return [];
}

function lineItemCellClass(status) {
  const normalized = String(status || "").toUpperCase();
  if (normalized === "TP") return "cell-tp";
  if (normalized === "GREY") return "cell-grey";
  return "cell-fp";
}

function rowStatusBadgeClass(rowStatus) {
  if (rowStatus === "PASS") return "success";
  if (rowStatus === "PARTIAL") return "warning";
  return "error";
}

function renderLineItemsField(field, result) {
  const lineItems = result.line_items || {};
  const columns = lineItemColumns(result);
  const rowResults = lineItems.row_results || [];
  const passedRows = rowResults.filter((row) => row.row_status === "PASS").length;
  const totalRows = Number(lineItems.total_golden_rows ?? rowResults.length);
  return `
    <article class="field-detail-row field-detail-row--${fieldRowModifier(result.status)} line-items-field">
      <details>
        <summary>
          <strong>${escapeHtml(field)} — ${passedRows}/${totalRows} rows matched</strong>
          ${statusBadge(result.status)}
        </summary>
        <div class="line-items-result-wrap">
          <table class="line-items-result-table">
            <thead>
              <tr>
                <th>Row #</th>
                ${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${
                rowResults.length
                  ? rowResults
                      .map(
                        (row, index) => `
                          <tr>
                            <td>${index + 1}</td>
                            ${columns
                              .map((column) => {
                                const cell = row.column_results?.[column] || {};
                                return `
                                  <td class="${lineItemCellClass(cell.status)}">
                                    <span>${escapeHtml(cell.golden_value ?? "")}</span>
                                    <small>${escapeHtml(cell.extracted_value ?? "")}</small>
                                  </td>
                                `;
                              })
                              .join("")}
                            <td><span class="badge badge--${rowStatusBadgeClass(row.row_status)}">${escapeHtml(row.row_status || "FAIL")}</span></td>
                          </tr>
                        `,
                      )
                      .join("")
                  : `<tr><td colspan="${columns.length + 2}" class="empty-row">No matched rows</td></tr>`
              }
            </tbody>
          </table>
        </div>
        <div class="line-items-footnotes">
          ${
            Number(lineItems.missing_rows || 0)
              ? `<span>${Number(lineItems.missing_rows || 0)} rows in golden not found in extraction</span>`
              : ""
          }
          ${
            Number(lineItems.extra_rows || 0)
              ? `<span>${Number(lineItems.extra_rows || 0)} rows extracted not in golden</span>`
              : ""
          }
        </div>
        ${renderOcrAccordion(result)}
      </details>
    </article>
  `;
}

function renderModalFieldDetails(fields) {
  const order = { FN: 0, FP: 1, EXTRA: 1, PARTIAL: 1, GREY: 2, GREY_UNRESOLVED: 2, EXTRA_INFO: 2, PRESENT: 2, ABSENT: 2, TP: 3 };
  const rows = Object.entries(fields)
    .filter(([, result]) => state.activeFieldFilter === "all" || fieldGroup(result?.status) === state.activeFieldFilter)
    .sort((a, b) => (order[a[1]?.status] ?? 4) - (order[b[1]?.status] ?? 4) || a[0].localeCompare(b[0]));
  if (!rows.length) {
    els.modalFieldDetails.innerHTML = '<div class="empty-inline">No fields match this filter.</div>';
    return;
  }
  els.modalFieldDetails.innerHTML = rows
    .map(([field, result]) => {
      if (result.field_type === "line_items" || result.line_items) {
        return renderLineItemsField(field, result);
      }
      const judge = result.llm_judge
        ? `<span class="llm-chip">LLM resolved: ${escapeHtml(result.llm_judge.verdict || "-")}</span>`
        : "";
      return `
        <article class="field-detail-row field-detail-row--${fieldRowModifier(result.status)}">
          <div class="field-name-cell">${escapeHtml(field)}</div>
          <div class="value-pair">
            <div><span>Expected</span><p>${escapeHtml(result.golden_value)}</p></div>
            <div><span>Extracted</span><p>${escapeHtml(result.extracted_value)}</p></div>
          </div>
          <div class="field-badges">
            <span class="score-badge">${escapeHtml(formatFieldScore(result))}</span>
            ${statusBadge(result.status)}
            ${judge}
          </div>
          ${renderOcrAccordion(result)}
        </article>
      `;
    })
    .join("");
}

function openReportModal(report) {
  state.activeModalReport = report;
  state.activeFieldFilter = "all";
  const scores = scoresFor(report);
  const fields = fieldsFor(report);

  setText(els.modalFilename, reportName(report) || "report.json");
  setText(els.modalTitle, "View report");
  setText(els.modalRunId, shortRunId(report));
  els.modalRunId.title = report.run_id || "";
  setText(els.modalDocType, report.document_type || "unknown");
  setText(els.modalF1, formatScore(scores.f1));
  setText(els.modalPrecision, formatScore(scores.precision));
  setText(els.modalRecall, formatScore(scores.recall));

  const format = reportFormat(report);
  const legacy = format === "legacy";
  const unknown = format === "unknown";
  if (legacy) {
    setBanner(els.modalLegacyNote, "This is an older report format.", "warning");
  } else if (unknown) {
    setBanner(els.modalLegacyNote, "Unknown report format.", "warning");
  } else {
    clearBanner(els.modalLegacyNote);
  }
  els.modalLegacyData.classList.toggle("hidden", !legacy);
  els.modalLegacyData.innerHTML = legacy
    ? `
      <pre class="legacy-data">OCR eval:\n${escapeHtml(JSON.stringify(report.ocr_eval || {}, null, 2))}</pre>
      <pre class="legacy-data">LLM eval:\n${escapeHtml(JSON.stringify(report.llm_eval || {}, null, 2))}</pre>
    `
    : "";

  els.modalInsights.innerHTML = generateInsights(report).map((item) => insightRow(item.icon, item.tone, item.text)).join("");
  renderModalActions(report);
  renderModalFieldFilters(fields);
  renderModalFieldDetails(fields);
  setModalTab("summary");
  els.reportModal.classList.remove("hidden");
}

function downloadReport(report) {
  const fileName = reportName(report) || "docsai_eval_report.json";
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function wireReportModal() {
  els.tabs.forEach((tab) => tab.addEventListener("click", () => setModalTab(tab.dataset.tab)));
  els.modalFieldFilters.addEventListener("click", (event) => {
    const button = event.target.closest("[data-field-filter]");
    if (!button || !state.activeModalReport) return;
    state.activeFieldFilter = button.dataset.fieldFilter;
    renderModalFieldFilters(fieldsFor(state.activeModalReport));
    renderModalFieldDetails(fieldsFor(state.activeModalReport));
  });
  els.modalDownloadButton.addEventListener("click", () => {
    if (state.activeModalReport) downloadReport(state.activeModalReport);
  });
  els.modalCloseButton.addEventListener("click", () => {
    els.reportModal.classList.add("hidden");
  });
  els.reportModal.addEventListener("click", (event) => {
    if (event.target === els.reportModal) els.reportModal.classList.add("hidden");
  });
}

/* ---------- Wiring ---------- */

function setSideTab(tabName) {
  els.sideTabs.forEach((tab) => tab.classList.toggle("tab--active", tab.dataset.sideTab === tabName));
  els.sidePanels.forEach((panel) => panel.classList.toggle("hidden", panel.dataset.sidePanel !== tabName));
}

function wireSidePanelTabs() {
  els.sideTabs.forEach((tab) => {
    tab.addEventListener("click", () => setSideTab(tab.dataset.sideTab));
  });
}

function wireJsonPreview() {
  els.jsonPreviewDocType.addEventListener("input", () => {
    validateNameInput(els.jsonPreviewDocType);
    renderJsonPreview();
  });
  els.jsonPreviewCopyButton.addEventListener("click", async () => {
    if (els.jsonPreviewOutput.classList.contains("hidden")) return;
    try {
      await navigator.clipboard.writeText(els.jsonPreviewOutput.textContent);
      showToast("Copied JSON to clipboard");
    } catch (error) {
      showToast("Could not copy JSON to clipboard");
    }
  });
}

function wireEvaluationForm() {
  createFieldRow("simple");
  wireAddFieldChips();
  wireSidePanelTabs();
  wireJsonPreview();
  wireSchemaImport();
  els.loadFieldsButton.addEventListener("click", loadRunFields);
  els.evalForm.addEventListener("submit", runEvaluation);
  els.extractedFieldPills.addEventListener("click", (event) => {
    const tableButton = event.target.closest("[data-table-hint]");
    if (tableButton) {
      const fieldName = tableButton.dataset.tableHint;
      const meta = state.fieldMetadata[fieldName] || {};
      createTableBlock({ fieldName, columns: meta.field_schema || [], rows: [] });
      return;
    }
    const pill = event.target.closest("[data-field]");
    if (!pill) return;
    addEntryByType(pill.dataset.entryType || "simple", { fieldName: pill.dataset.field, value: "" });
  });
  els.runId.addEventListener("input", () => {
    const hasEntries = entryNodes().some((entry) => entryHasContent(entry));
    if (!els.runId.value.trim() && hasEntries) {
      setBanner(els.runFieldsBanner, "Clearing run ID will keep your field entries. Change the run ID to re-run with new data.", "error");
    } else {
      clearBanner(els.runFieldsBanner);
    }
    maybeOfferRestore();
    updateRunButtonState();
  });
  els.restoreYes.addEventListener("click", restoreSessionFields);
  els.restoreNo.addEventListener("click", () => {
    els.restorePrompt.classList.add("hidden");
  });
  els.openReportButton.addEventListener("click", async () => {
    if (!state.currentRunReport) return;
    const name = reportName(state.currentRunReport);
    const fullReport = name ? await getReport(name).catch(() => state.currentRunReport) : state.currentRunReport;
    openReportModal(fullReport);
  });
}

function wireSettings() {
  els.refreshHealthButton.addEventListener("click", loadHealth);
}

function init() {
  wireNavigation();
  wireEvaluationForm();
  wireHistory();
  wireReportModal();
  wireSettings();
  restoreActivePage();
  refreshAll();
}

init();
