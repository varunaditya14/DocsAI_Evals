const FIELD_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*$/;
const MAX_FIELDS = 30;
const MAX_TABLE_COLUMNS = 10;
const MAX_TABLE_ROWS = 50;
const RESTORE_PREFIX = "docsai-evals:";
const progressMessages = [
  "Fetching run output...",
  "Comparing fields...",
  "Running LLM judge on uncertain fields...",
  "Analysing failed fields in OCR output...",
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
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const els = {
  views: $$(".view"),
  navItems: $$(".nav-item"),
  topHealthDot: $("#topHealthDot"),
  topHealthText: $("#topHealthText"),
  dashboardHealthPill: $("#dashboardHealthPill"),
  dashboardError: $("#dashboardError"),
  totalRuns: $("#totalRuns"),
  averageF1: $("#averageF1"),
  promptProblems: $("#promptProblems"),
  ocrLimitations: $("#ocrLimitations"),
  latestReportLabel: $("#latestReportLabel"),
  latestPrecision: $("#latestPrecision"),
  latestRecall: $("#latestRecall"),
  latestF1: $("#latestF1"),
  latestMissing: $("#latestMissing"),
  recentReportsBody: $("#recentReportsBody"),
  evalForm: $("#evalForm"),
  runId: $("#runId"),
  loadFieldsButton: $("#loadFieldsButton"),
  runFieldsMessage: $("#runFieldsMessage"),
  restorePrompt: $("#restorePrompt"),
  restoreYes: $("#restoreYes"),
  restoreNo: $("#restoreNo"),
  detectedPanel: $("#detectedPanel"),
  detectedDocType: $("#detectedDocType"),
  detectedFieldCount: $("#detectedFieldCount"),
  fieldRows: $("#fieldRows"),
  addFieldButton: $("#addFieldButton"),
  fieldTypePicker: $("#fieldTypePicker"),
  extractedHintsPanel: $("#extractedHintsPanel"),
  extractedFieldPills: $("#extractedFieldPills"),
  runStatus: $("#runStatus"),
  runMessage: $("#runMessage"),
  progressText: $("#progressText"),
  runButton: $("#runButton"),
  resultSubtitle: $("#resultSubtitle"),
  resultStatus: $("#resultStatus"),
  resultRunId: $("#resultRunId"),
  resultDocumentType: $("#resultDocumentType"),
  resultPrecision: $("#resultPrecision"),
  resultRecall: $("#resultRecall"),
  resultF1: $("#resultF1"),
  resultPassed: $("#resultPassed"),
  resultFailed: $("#resultFailed"),
  resultMissing: $("#resultMissing"),
  resultPromptProblems: $("#resultPromptProblems"),
  resultOcrLimitations: $("#resultOcrLimitations"),
  resultUncertain: $("#resultUncertain"),
  resultLlmDecisions: $("#resultLlmDecisions"),
  resultFieldScores: $("#resultFieldScores"),
  resultRecommendedActions: $("#resultRecommendedActions"),
  openLatestReport: $("#openLatestReport"),
  historySearch: $("#historySearch"),
  refreshReports: $("#refreshReports"),
  historyMessage: $("#historyMessage"),
  reportCount: $("#reportCount"),
  sortF1: $("#sortF1"),
  sortF1Indicator: $("#sortF1Indicator"),
  historyBody: $("#historyBody"),
  historyPrev: $("#historyPrev"),
  historyNext: $("#historyNext"),
  historyPageLabel: $("#historyPageLabel"),
  refreshHealth: $("#refreshHealth"),
  healthMessage: $("#healthMessage"),
  healthStatus: $("#healthStatus"),
  apiBaseUrl: $("#apiBaseUrl"),
  healthResultsPath: $("#healthResultsPath"),
  healthOpenAi: $("#healthOpenAi"),
  toast: $("#toast"),
  reportModal: $("#reportModal"),
  closeModal: $("#closeModal"),
  modalTitle: $("#modalTitle"),
  modalSubtitle: $("#modalSubtitle"),
  modalRunId: $("#modalRunId"),
  modalDocumentType: $("#modalDocumentType"),
  modalTimestamp: $("#modalTimestamp"),
  modalF1: $("#modalF1"),
  reportTabs: $$(".modal-tab"),
  reportPanels: $$(".report-tab-panel"),
  legacyReportNote: $("#legacyReportNote"),
  legacyOcrData: $("#legacyOcrData"),
  summaryF1: $("#summaryF1"),
  summaryPassed: $("#summaryPassed"),
  summaryFailed: $("#summaryFailed"),
  summaryMissing: $("#summaryMissing"),
  insightList: $("#insightList"),
  recommendedActions: $("#recommendedActions"),
  downloadSummaryReport: $("#downloadSummaryReport"),
  fieldFilters: $("#fieldFilters"),
  fieldDetailsList: $("#fieldDetailsList"),
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

function setHidden(element, hidden) {
  if (element) element.hidden = hidden;
}

function setBanner(element, message, type = "error") {
  if (!element) return;
  element.textContent = message;
  element.className = `banner ${type}`;
  element.hidden = false;
}

function clearBanner(element) {
  if (!element) return;
  element.textContent = "";
  element.hidden = true;
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

function countLlmJudgeResults(report) {
  return Object.values(fieldsFor(report)).filter((field) => field?.llm_judge).length;
}

function isLegacyReport(report) {
  return !report.field_comparison && Boolean(report.ocr_eval);
}

function statusClass(status) {
  const normalized = String(status || "").toUpperCase();
  if (["TP", "PASS"].includes(normalized)) return "completed";
  if (["FP", "FAIL", "EXTRA"].includes(normalized)) return "failed";
  if (["FN", "MISSING"].includes(normalized)) return "missing";
  if (normalized === "PARTIAL") return "partial";
  if (["GREY", "GREY_UNRESOLVED", "UNCERTAIN", "EXTRA_INFO"].includes(normalized)) return "unresolved";
  return "partial";
}

function statusLabel(status) {
  const normalized = String(status || "").toUpperCase();
  if (normalized === "TP") return "PASS";
  if (normalized === "FP") return "FAIL";
  if (normalized === "FN") return "MISSING";
  if (normalized === "GREY" || normalized === "GREY_UNRESOLVED") return "UNCERTAIN";
  if (normalized === "EXTRA_INFO") return "EXTRA INFO";
  if (normalized === "PARTIAL") return "PARTIAL";
  return normalized || "PARTIAL";
}

function statusPill(status) {
  return `<span class="status-pill ${statusClass(status)}">${escapeHtml(statusLabel(status))}</span>`;
}

function reportActionButtons(name) {
  return `${reportActionButton(name, "view")}${reportActionButton(name, "delete")}`;
}

function reportActionButton(name, action) {
  const safeName = escapeHtml(name);
  const isDelete = action === "delete";
  return `
    <button class="icon-action ${isDelete ? "danger" : ""}" type="button" data-action="${action}" data-report="${safeName}" title="${isDelete ? "Delete" : "View"} report" aria-label="${isDelete ? "Delete" : "View"} report">
      <span class="ti ${isDelete ? "ti-trash" : "ti-eye"}"></span>
    </button>
  `;
}

function showSection(sectionName) {
  els.views.forEach((view) => view.classList.toggle("active", view.id === sectionName));
  els.navItems.forEach((item) => item.classList.toggle("active", item.dataset.section === sectionName));
}

function entryNodes() {
  return $$(".field-entry");
}

function entryCount() {
  return entryNodes().length;
}

function inputValidClass(input, isValid, isEmpty) {
  input.classList.toggle("invalid", !isEmpty && !isValid);
  input.classList.toggle("valid", false);
}

function validateNameInput(input, errorElement, message = "camelCase only - e.g. invoiceNo, totalAmount", showError = true) {
  const value = input.value.trim();
  const isEmpty = value === "";
  const isValid = FIELD_NAME_PATTERN.test(value);
  inputValidClass(input, isValid, isEmpty);
  if (errorElement) {
    errorElement.textContent = message;
    errorElement.hidden = !showError || isEmpty || isValid;
  }
  return { value, isEmpty, isValid };
}

function autoGrowTextarea(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.max(textarea.scrollHeight, 96)}px`;
}

function removeEntry(entry) {
  entry.remove();
  if (!entryNodes().length) addSimpleFieldRow();
  updateRunButtonState();
}

function ensureEntryLimit() {
  if (entryCount() >= MAX_FIELDS) {
    showToast("Maximum 30 fields per evaluation");
    return false;
  }
  return true;
}

function addSimpleFieldRow(name = "", value = "") {
  if (!ensureEntryLimit()) return;
  const row = document.createElement("div");
  row.className = "field-entry field-entry-row";
  row.dataset.entryType = "simple";
  row.innerHTML = `
    <div class="field-input-wrap">
      <input data-field-name type="text" placeholder="fieldName" value="${escapeHtml(name)}" autocomplete="off" />
      <small data-field-error class="field-error" hidden>camelCase only - e.g. invoiceNo, totalAmount</small>
    </div>
    <div class="field-input-wrap">
      <input data-field-value type="text" placeholder="expected value" value="${escapeHtml(value)}" />
      <small data-field-warning class="field-warning" hidden>Empty value - this field will be marked as MISSING if not extracted</small>
    </div>
    <button class="icon-button muted remove-field" type="button" title="Remove field" aria-label="Remove field">
      <span class="ti ti-x"></span>
    </button>
  `;
  els.fieldRows.appendChild(row);
  row.querySelector("[data-field-name]").addEventListener("input", updateRunButtonState);
  row.querySelector("[data-field-value]").addEventListener("input", updateRunButtonState);
  row.querySelector(".remove-field").addEventListener("click", () => removeEntry(row));
  updateRunButtonState();
}

function addTextBlockRow(name = "", value = "") {
  if (!ensureEntryLimit()) return;
  const row = document.createElement("div");
  row.className = "field-entry text-block-row";
  row.dataset.entryType = "text_block";
  row.innerHTML = `
    <div class="field-input-wrap text-block-name">
      <input data-field-name type="text" placeholder="fieldName" value="${escapeHtml(name)}" autocomplete="off" />
      <small data-field-error class="field-error" hidden>camelCase only - e.g. invoiceNo, totalAmount</small>
    </div>
    <div class="field-input-wrap text-block-value">
      <textarea data-field-value rows="3" placeholder="Enter multiline value...">${escapeHtml(value)}</textarea>
    </div>
    <button class="icon-button muted remove-field" type="button" title="Remove field" aria-label="Remove field">
      <span class="ti ti-x"></span>
    </button>
  `;
  els.fieldRows.appendChild(row);
  const textarea = row.querySelector("textarea");
  row.querySelector("[data-field-name]").addEventListener("input", updateRunButtonState);
  textarea.addEventListener("input", () => {
    autoGrowTextarea(textarea);
    updateRunButtonState();
  });
  row.querySelector(".remove-field").addEventListener("click", () => removeEntry(row));
  autoGrowTextarea(textarea);
  updateRunButtonState();
}

function tableColumns(table) {
  return Array.from(table.querySelectorAll("[data-column-name]")).map((input) => input.value.trim());
}

function tableRows(table) {
  return Array.from(table.querySelectorAll(".table-data-row")).map((row) => {
    return Array.from(row.querySelectorAll("[data-cell]")).map((input) => input.value.trim());
  });
}

function rebuildTableRows(table, existingRows = tableRows(table)) {
  const columns = tableColumns(table);
  const labels = table.querySelector("[data-table-column-labels]");
  const rowsContainer = table.querySelector("[data-table-rows]");
  labels.innerHTML = columns.map((column) => `<span>${escapeHtml(column || "Column")}</span>`).join("");
  labels.hidden = columns.length === 0;
  rowsContainer.innerHTML = "";
  existingRows.forEach((rowValues) => addTableDataRow(table, rowValues, false));
  table.querySelector("[data-add-row]").disabled = columns.length === 0 || tableRows(table).length >= MAX_TABLE_ROWS;
}

function addTableColumn(table, columnName = "") {
  const columnsContainer = table.querySelector("[data-table-columns]");
  if (columnsContainer.querySelectorAll("[data-column-name]").length >= MAX_TABLE_COLUMNS) {
    showToast("Maximum 10 columns per table");
    return;
  }
  const existingRows = tableRows(table);
  const column = document.createElement("div");
  column.className = "table-column-input";
  column.innerHTML = `
    <input data-column-name type="text" placeholder="columnName (e.g. description)" value="${escapeHtml(columnName)}" />
    <button class="icon-button muted" type="button" title="Remove column" aria-label="Remove column">
      <span class="ti ti-x"></span>
    </button>
    <small data-column-error class="field-error" hidden>camelCase only - e.g. invoiceNo, totalAmount</small>
  `;
  columnsContainer.appendChild(column);
  const input = column.querySelector("[data-column-name]");
  input.addEventListener("input", () => {
    rebuildTableRows(table);
    updateRunButtonState();
  });
  column.querySelector("button").addEventListener("click", () => {
    const columnIndex = Array.from(columnsContainer.children).indexOf(column);
    const currentRows = tableRows(table);
    column.remove();
    const adjustedRows = currentRows.map((row) => row.filter((_cell, index) => index !== columnIndex));
    rebuildTableRows(table, adjustedRows);
    updateRunButtonState();
  });
  rebuildTableRows(table, existingRows);
  updateRunButtonState();
}

function addTableDataRow(table, values = [], shouldUpdate = true) {
  const columns = tableColumns(table);
  if (!columns.length) {
    showToast("Add at least one column first");
    return;
  }
  if (tableRows(table).length >= MAX_TABLE_ROWS) {
    showToast("Maximum 50 rows per table");
    return;
  }
  const row = document.createElement("div");
  row.className = "table-data-row";
  row.innerHTML = `
    ${columns
      .map((column, index) => `<input data-cell type="text" placeholder="${escapeHtml(column || "value")}" value="${escapeHtml(values[index] || "")}" />`)
      .join("")}
    <button class="icon-button muted" type="button" title="Remove row" aria-label="Remove row">
      <span class="ti ti-x"></span>
    </button>
  `;
  table.querySelector("[data-table-rows]").appendChild(row);
  row.querySelectorAll("[data-cell]").forEach((input) => input.addEventListener("input", updateRunButtonState));
  row.querySelector("button").addEventListener("click", () => {
    row.remove();
    updateRunButtonState();
  });
  if (shouldUpdate) updateRunButtonState();
}

function addLineItemsTable(entry = {}) {
  if (!ensureEntryLimit()) return;
  const table = document.createElement("div");
  table.className = "field-entry table-entry-card";
  table.dataset.entryType = "line_items";
  table.innerHTML = `
    <div class="table-entry-header">
      <span class="table-badge">TABLE</span>
      <div class="field-input-wrap table-name-wrap">
        <input data-field-name type="text" placeholder="lineItems" value="${escapeHtml(entry.fieldName || "")}" autocomplete="off" />
        <small data-field-error class="field-error" hidden>camelCase only - e.g. invoiceNo, totalAmount</small>
      </div>
      <button data-add-column class="secondary-button" type="button">
        <span class="ti ti-plus" aria-hidden="true"></span>
        Add column
      </button>
      <button class="icon-button muted remove-field" type="button" title="Remove table" aria-label="Remove table">
        <span class="ti ti-x"></span>
      </button>
    </div>
    <div data-table-warning class="field-warning" hidden></div>
    <div data-table-columns class="table-columns-row"></div>
    <div data-table-column-labels class="table-column-labels"></div>
    <div data-table-rows class="table-rows"></div>
    <button data-add-row class="table-add-row-btn secondary-button" type="button">+ Add row</button>
  `;
  els.fieldRows.appendChild(table);
  table.querySelector("[data-field-name]").addEventListener("input", updateRunButtonState);
  table.querySelector("[data-add-column]").addEventListener("click", () => addTableColumn(table));
  table.querySelector("[data-add-row]").addEventListener("click", () => addTableDataRow(table));
  table.querySelector(".remove-field").addEventListener("click", () => removeEntry(table));
  (entry.columns || []).forEach((column) => addTableColumn(table, column));
  (entry.rows || []).forEach((row) => addTableDataRow(table, row, false));
  updateRunButtonState();
}

function addFieldRow(name = "", value = "") {
  addSimpleFieldRow(name, value);
}

function addEntryByType(type, data = {}) {
  if (type === "text_block") {
    addTextBlockRow(data.fieldName || data.name || "", data.value || "");
  } else if (type === "line_items") {
    addLineItemsTable(data);
  } else {
    addSimpleFieldRow(data.fieldName || data.name || "", data.value || "");
  }
}

function entryHasContent(entry) {
  if (entry.dataset.entryType === "line_items") {
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
    const error = entry.querySelector("[data-field-error]");
    validateNameInput(entry.querySelector("[data-field-name]"), error, undefined, false);
  });
  els.runButton.disabled = !(hasRunId && hasSubmittableEntry());
  els.addFieldButton.disabled = entryCount() >= MAX_FIELDS;
}

function collectGoldenFields(showErrors = false) {
  const fields = {};
  const entries = [];
  const errors = [];
  const warnings = [];
  const names = new Set();

  entryNodes().forEach((entry) => {
    const type = entry.dataset.entryType || "simple";
    const nameInput = entry.querySelector("[data-field-name]");
    const fieldError = entry.querySelector("[data-field-error]");
    const nameResult = validateNameInput(nameInput, fieldError, undefined, showErrors);
    const name = nameResult.value;

    if (!name && type !== "line_items") return;
    if (!name && !entryHasContent(entry)) return;
    if (!name && entryHasContent(entry)) {
      errors.push("Field name is required for entries with values");
      if (fieldError) {
        fieldError.textContent = "Field name is required";
        fieldError.hidden = false;
      }
      return;
    }
    if (!nameResult.isValid) {
      errors.push(`${name || "Field name"} must be camelCase`);
      return;
    }
    if (names.has(name)) {
      errors.push(`Field name ${name} is used more than once`);
      if (fieldError) {
        fieldError.textContent = `Field name ${name} is used more than once`;
        fieldError.hidden = false;
      }
      return;
    }
    names.add(name);

    if (type === "line_items") {
      const warning = entry.querySelector("[data-table-warning]");
      const columns = tableColumns(entry);
      const validColumns = [];
      let hasColumnError = false;
      entry.querySelectorAll("[data-column-name]").forEach((input) => {
        const error = input.parentElement.querySelector("[data-column-error]");
        const result = validateNameInput(input, error, undefined, showErrors);
        if (showErrors && result.isEmpty && error) {
          error.textContent = "Column name is required";
          error.hidden = false;
        }
        if (!result.isValid) hasColumnError = true;
        validColumns.push(result.value);
      });
      if (!columns.length) {
        errors.push(`${name}: Add at least one column`);
        if (warning) {
          warning.textContent = "Add at least one column";
          warning.hidden = false;
        }
        return;
      }
      if (hasColumnError) {
        errors.push(`${name}: column names must be camelCase`);
        return;
      }

      const rows = tableRows(entry).filter((row) => row.some((cell) => cell.trim() !== ""));
      if (!rows.length) {
        const message = `Table ${name} has no rows - it will check only that the field exists in extraction output`;
        warnings.push(message);
        if (warning) {
          warning.textContent = message;
          warning.hidden = false;
        }
      } else if (warning) {
        warning.hidden = true;
      }
      fields[name] = rows.map((row) => Object.fromEntries(validColumns.map((column, index) => [column, row[index] || ""])));
      entries.push({ type: "line_items", fieldName: name, columns: validColumns, rows });
      return;
    }

    const value = entry.querySelector("[data-field-value]").value.trim();
    const warning = entry.querySelector("[data-field-warning]");
    if (warning) warning.hidden = !(showErrors && value === "");
    fields[name] = value;
    entries.push({ type, fieldName: name, value });
  });

  if (!entries.length) errors.push("Add at least one field to evaluate");
  return { fields, entries, errors, warnings, validCount: entries.length };
}

function renderExtractedHints(fields, metadata = {}) {
  const entries = Object.entries(fields || {});
  if (!entries.length) {
    setBanner(els.runFieldsMessage, "No fields detected in this run. The extraction step may not have produced output.", "error");
    els.extractedHintsPanel.hidden = true;
    return;
  }
  els.extractedFieldPills.innerHTML = entries
    .map(([field, value]) => {
      const fieldMeta = metadata[field] || {};
      if (fieldMeta.field_value_type === "table") {
        const columns = fieldMeta.field_schema || [];
        return `
          <article class="table-hint-card">
            <strong>This run has a table field: ${escapeHtml(field)}</strong>
            <span>${Number(fieldMeta.row_count || 0)} rows, columns: ${escapeHtml(columns.join(", ") || "-")}</span>
            <button class="secondary-button" type="button" data-table-hint="${escapeHtml(field)}">Add as table</button>
          </article>
        `;
      }
      const type = fieldMeta.field_value_type === "text_block" ? "text_block" : "simple";
      const title = typeof value === "string" ? value : JSON.stringify(value);
      return `<button class="field-pill" type="button" data-field="${escapeHtml(field)}" data-entry-type="${type}" title="${escapeHtml(title)}">${escapeHtml(field)}</button>`;
    })
    .join("");
  els.extractedHintsPanel.hidden = false;
  els.extractedHintsPanel.open = true;
}

function restoreStorageKey() {
  const runId = els.runId.value.trim();
  return runId ? `${RESTORE_PREFIX}${runId}` : "";
}

function maybeOfferRestore() {
  const key = restoreStorageKey();
  els.restorePrompt.hidden = !(key && sessionStorage.getItem(key));
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
    if (Array.isArray(savedEntries)) {
      savedEntries.forEach((entry) => addEntryByType(entry.type || "simple", entry));
    } else {
      Object.entries(savedEntries).forEach(([field, value]) => addFieldRow(field, value));
    }
    els.restorePrompt.hidden = true;
    showToast("Previous values restored");
  } catch {
    sessionStorage.removeItem(key);
  }
}

async function loadRunFields() {
  const runId = els.runId.value.trim();
  clearBanner(els.runFieldsMessage);
  if (!runId) {
    setBanner(els.runFieldsMessage, "Enter a DocsAI Run ID first.", "error");
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
    els.detectedPanel.hidden = false;
    renderExtractedHints(state.extractedFields, state.fieldMetadata);
    const message = payload.warning ? `Loaded fields. ${payload.warning}` : "Run fields loaded.";
    setBanner(els.runFieldsMessage, message, "success");
  } catch (error) {
    state.extractedFields = {};
    state.fieldMetadata = {};
    state.documentType = "";
    els.detectedPanel.hidden = true;
    els.extractedHintsPanel.hidden = true;
    setBanner(els.runFieldsMessage, error.message, "error");
  } finally {
    setButtonLoading(els.loadFieldsButton, false);
    maybeOfferRestore();
    updateRunButtonState();
  }
}

function startProgressMessages() {
  let index = 0;
  els.progressText.hidden = false;
  els.progressText.textContent = progressMessages[index];
  state.progressTimer = window.setInterval(() => {
    index = Math.min(index + 1, progressMessages.length - 1);
    els.progressText.textContent = progressMessages[index];
  }, 1800);
}

function stopProgressMessages() {
  if (state.progressTimer) window.clearInterval(state.progressTimer);
  state.progressTimer = null;
  els.progressText.hidden = true;
}

function rememberCurrentRun(report) {
  state.currentRunReport = report;
  state.latestReport = report;
  const name = reportName(report);
  if (name) state.reportCache.set(name, report);
}

function renderRunResult(report) {
  const scores = scoresFor(report);
  const summary = summaryFor(report);
  setText(els.resultSubtitle, reportName(report) || "Evaluation completed");
  setText(els.resultStatus, "COMPLETED");
  els.resultStatus.className = "status-pill completed";
  setText(els.resultRunId, report.run_id || "-");
  setText(els.resultDocumentType, report.document_type || "-");
  setText(els.resultPrecision, formatScore(scores.precision));
  setText(els.resultRecall, formatScore(scores.recall));
  setText(els.resultF1, formatScore(scores.f1));
  setText(els.resultPassed, summary.passed);
  setText(els.resultFailed, summary.failed);
  setText(els.resultMissing, summary.missing);
  setText(els.resultPromptProblems, summary.promptProblems);
  setText(els.resultOcrLimitations, summary.ocrLimitations);
  setText(els.resultUncertain, summary.uncertain);
  setText(els.resultLlmDecisions, report.summary?.uncertain_resolved ?? countLlmJudgeResults(report));
  setText(els.resultFieldScores, report.summary?.total_fields ?? Object.keys(fieldsFor(report)).length);
  setText(els.resultRecommendedActions, (report.recommended_actions || []).length);
  els.openLatestReport.disabled = false;
}

async function runEvaluation(event) {
  event.preventDefault();
  clearBanner(els.runMessage);
  const { fields, entries, errors, warnings, validCount } = collectGoldenFields(true);
  if (!els.runId.value.trim()) {
    setBanner(els.runMessage, "Enter a DocsAI Run ID before running evaluation.", "error");
    return;
  }
  if (errors.length) {
    setBanner(els.runMessage, errors.join(" | "), "error");
    return;
  }
  if (warnings.length) setBanner(els.runMessage, warnings.join(" | "), "success");
  els.runStatus.textContent = "RUNNING";
  els.runStatus.className = "status-pill partial";
  setButtonLoading(els.runButton, true, "Running...");
  startProgressMessages();
  try {
    const runId = els.runId.value.trim();
    const report = await api.runEvaluation({ run_id: runId, golden_fields: fields });
    saveSessionFields(runId, entries);
    rememberCurrentRun(report);
    renderRunResult(report);
    renderLatest(report);
    els.runStatus.textContent = "COMPLETED";
    els.runStatus.className = "status-pill completed";
    setBanner(els.runMessage, "Evaluation completed successfully.", "success");
    await Promise.all([loadSummary(), loadReports()]);
    openReportModal(report);
  } catch (error) {
    els.runStatus.textContent = "FAILED";
    els.runStatus.className = "status-pill failed";
    setBanner(els.runMessage, error.message, "error");
  } finally {
    stopProgressMessages();
    setButtonLoading(els.runButton, false);
    updateRunButtonState();
  }
}

function rowForReport(report) {
  const scores = scoresFor(report);
  const summary = summaryFor(report);
  return `
    <tr>
      <td title="${escapeHtml(report.run_id || "")}">${escapeHtml(shortRunId(report))}</td>
      <td>${escapeHtml(report.document_type || "unknown")}</td>
      <td>${formatScore(scores.f1)}</td>
      <td>${summary.passed}</td>
      <td>${summary.failed}</td>
      <td>${summary.missing}</td>
      <td>${escapeHtml(formatTimestamp(report.timestamp))}</td>
      <td>${reportActionButton(reportName(report), "view")}</td>
      <td>${reportActionButton(reportName(report), "delete")}</td>
    </tr>
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
          <td>${formatScore(scores.f1)}</td>
          <td>${summary.passed}</td>
          <td>${summary.failed}</td>
          <td>${summary.missing}</td>
          <td>${reportActionButtons(reportName(report))}</td>
        </tr>
      `;
    })
    .join("");
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
  setText(els.reportCount, `${reports.length} report${reports.length === 1 ? "" : "s"}`);
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

function renderSummary(summary) {
  setText(els.totalRuns, summary.total_runs ?? 0);
  setText(els.averageF1, formatScore(summary.average_f1));
  setText(els.promptProblems, summary.total_prompt_problems ?? 0);
  setText(els.ocrLimitations, summary.total_ocr_limitations ?? 0);
}

function renderLatest(report) {
  if (!report) {
    setText(els.latestReportLabel, "No report selected");
    setText(els.latestPrecision, "-");
    setText(els.latestRecall, "-");
    setText(els.latestF1, "-");
    setText(els.latestMissing, "-");
    return;
  }
  const scores = scoresFor(report);
  const summary = summaryFor(report);
  setText(els.latestReportLabel, report.run_id || reportName(report));
  setText(els.latestPrecision, formatScore(scores.precision));
  setText(els.latestRecall, formatScore(scores.recall));
  setText(els.latestF1, formatScore(scores.f1));
  setText(els.latestMissing, summary.missing);
}

async function loadHealth() {
  clearBanner(els.healthMessage);
  setText(els.apiBaseUrl, window.location.origin);
  try {
    const health = await api.health();
    els.topHealthDot.className = "health-dot ok";
    els.topHealthText.textContent = "Backend connected";
    els.dashboardHealthPill.textContent = "CONNECTED";
    els.dashboardHealthPill.className = "status-pill completed";
    setText(els.healthStatus, health.status || "ok");
    setText(els.healthResultsPath, String(Boolean(health.results_configured)));
    setText(els.healthOpenAi, String(Boolean(health.azure_openai_configured)));
  } catch (error) {
    els.topHealthDot.className = "health-dot fail";
    els.topHealthText.textContent = "Backend unavailable";
    els.dashboardHealthPill.textContent = "FAILED";
    els.dashboardHealthPill.className = "status-pill failed";
    setText(els.healthStatus, "Unavailable");
    setBanner(els.healthMessage, error.message, "error");
  }
}

async function loadSummary() {
  clearBanner(els.dashboardError);
  try {
    renderSummary(await api.summary());
  } catch (error) {
    setBanner(els.dashboardError, error.message, "error");
  }
}

async function loadReports() {
  clearBanner(els.historyMessage);
  try {
    const payload = await api.reports();
    state.reports = (payload.reports || []).sort((a, b) => reportRunTime(b) - reportRunTime(a));
    state.reports.forEach((report) => state.reportCache.set(report.name, report));
    state.latestReport = state.reports[0] || state.latestReport;
    renderLatest(state.latestReport);
    renderRecentReports();
    renderHistory();
  } catch (error) {
    setBanner(els.historyMessage, error.message, "error");
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

function setReportTab(tabName) {
  els.reportTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.reportTab === tabName));
  els.reportPanels.forEach((panel) => panel.classList.toggle("active", panel.dataset.reportPanel === tabName));
}

function insight(icon, tone, text) {
  return `<div class="insight-row tone-${tone}"><span class="ti ${icon} insight-icon tone-${tone}"></span><span>${escapeHtml(text)}</span></div>`;
}

function generateInsights(report) {
  const scores = scoresFor(report);
  const fields = fieldsFor(report);
  const insights = [];
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

function severityForAction(action) {
  const text = `${action.field || ""} ${action.action || ""}`.toLowerCase();
  if (text.includes("prompt")) return { label: "Prompt fix needed", tone: "prompt", order: 0 };
  if (text.includes("ocr")) return { label: "OCR limitation", tone: "ocr", order: 1 };
  return { label: "Investigate", tone: "investigate", order: 2 };
}

function renderActions(report) {
  const actions = [...(report.recommended_actions || [])].sort((a, b) => severityForAction(a).order - severityForAction(b).order);
  if (!actions.length) {
    els.recommendedActions.innerHTML = '<div class="empty-inline">No recommended actions for this report.</div>';
    return;
  }
  els.recommendedActions.innerHTML = actions
    .map((action) => {
      const severity = severityForAction(action);
      return `
        <article class="action-card">
          <div><strong>${escapeHtml(action.field)}</strong><span class="severity-badge ${severity.tone}">${escapeHtml(severity.label)}</span></div>
          <p>${escapeHtml(action.action)}</p>
        </article>
      `;
    })
    .join("");
}

function fieldGroup(status) {
  const normalized = String(status || "").toUpperCase();
  if (normalized === "TP") return "passed";
  if (["FP", "EXTRA", "PARTIAL"].includes(normalized)) return "failed";
  if (normalized === "FN") return "missing";
  if (["GREY", "GREY_UNRESOLVED", "EXTRA_INFO"].includes(normalized)) return "uncertain";
  return "uncertain";
}

function renderFieldFilters(fields) {
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
  els.fieldFilters.innerHTML = labels
    .map(([key, label]) => {
      return `<button class="line-filter-tab ${state.activeFieldFilter === key ? "active" : ""}" type="button" data-field-filter="${key}">${label} <span>${counts[key]}</span></button>`;
    })
    .join("");
}

function formatFieldScore(result) {
  if (result.status === "FN" || result.score === null || result.score === undefined) return "-";
  if (["date", "numeric"].includes(String(result.field_type || ""))) return result.score === 100 ? "exact" : "0.0%";
  return `${Number(result.score || 0).toFixed(1)}%`;
}

function renderOcrSearch(result) {
  const search = result.ocr_search;
  if (!search) return "";
  const verdictClass = String(search.verdict || "UNCERTAIN").toLowerCase();
  return `
    <details class="ocr-search ${verdictClass}">
      <summary>
        <span class="status-pill ${verdictClass === "prompt_problem" ? "missing" : verdictClass === "ocr_limitation" ? "failed" : "unresolved"}">
          ${escapeHtml(String(search.verdict || "UNCERTAIN").replaceAll("_", " "))}
        </span>
        OCR diagnosis
      </summary>
      <p>${escapeHtml(search.reason || "-")}</p>
      <small>${Number(search.occurrence_count || 0)} occurrence(s) found in OCR</small>
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

function renderLineItemsField(field, result) {
  const lineItems = result.line_items || {};
  const columns = lineItemColumns(result);
  const rowResults = lineItems.row_results || [];
  const passedRows = rowResults.filter((row) => row.row_status === "PASS").length;
  const totalRows = Number(lineItems.total_golden_rows ?? rowResults.length);
  return `
    <article class="field-detail-row line-items-field ${statusClass(result.status)}">
      <details>
        <summary>
          <strong>${escapeHtml(field)} - ${passedRows}/${totalRows} rows passed</strong>
          ${statusPill(result.status)}
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
                      .map((row, index) => {
                        return `
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
                            <td><span class="row-status-badge ${String(row.row_status || "FAIL").toLowerCase()}">${escapeHtml(row.row_status || "FAIL")}</span></td>
                          </tr>
                        `;
                      })
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
        ${renderOcrSearch(result)}
      </details>
    </article>
  `;
}

function renderFieldDetails(fields) {
  const order = { FN: 0, FP: 1, EXTRA: 1, PARTIAL: 1, GREY: 2, GREY_UNRESOLVED: 2, EXTRA_INFO: 2, TP: 3 };
  const rows = Object.entries(fields)
    .filter(([, result]) => state.activeFieldFilter === "all" || fieldGroup(result?.status) === state.activeFieldFilter)
    .sort((a, b) => (order[a[1]?.status] ?? 4) - (order[b[1]?.status] ?? 4) || a[0].localeCompare(b[0]));
  if (!rows.length) {
    els.fieldDetailsList.innerHTML = '<div class="empty-inline">No fields match this filter.</div>';
    return;
  }
  els.fieldDetailsList.innerHTML = rows
    .map(([field, result]) => {
      if (result.field_type === "line_items" || result.line_items) {
        return renderLineItemsField(field, result);
      }
      const judge = result.llm_judge
        ? `<span class="small-tag">LLM resolved: ${escapeHtml(result.llm_judge.verdict || "-")}</span>`
        : "";
      return `
        <article class="field-detail-row ${statusClass(result.status)}">
          <div class="field-name-cell"><strong>${escapeHtml(field)}</strong></div>
          <div class="value-pair">
            <div><span>Expected</span><p>${escapeHtml(result.golden_value)}</p></div>
            <div><span>Extracted</span><p>${escapeHtml(result.extracted_value)}</p></div>
          </div>
          <div class="field-badges">
            <span class="score-badge">${escapeHtml(formatFieldScore(result))}</span>
            ${statusPill(result.status)}
            ${judge}
          </div>
          ${renderOcrSearch(result)}
        </article>
      `;
    })
    .join("");
}

function openReportModal(report) {
  state.activeModalReport = report;
  state.activeFieldFilter = "all";
  const scores = scoresFor(report);
  const summary = summaryFor(report);
  const fields = fieldsFor(report);

  setText(els.modalTitle, reportName(report) || "Evaluation Report");
  setText(els.modalSubtitle, `${report.run_id || report.filename || "-"} | ${formatTimestamp(report.timestamp)}`);
  setText(els.modalRunId, report.run_id || "-");
  setText(els.modalDocumentType, report.document_type || "unknown");
  setText(els.modalTimestamp, formatTimestamp(report.timestamp));
  setText(els.modalF1, formatScore(scores.f1));
  setText(els.summaryF1, formatScore(scores.f1));
  setText(els.summaryPassed, summary.passed);
  setText(els.summaryFailed, Number(summary.failed) + Number(summary.missing));
  setText(els.summaryMissing, summary.missing);

  const legacy = isLegacyReport(report);
  els.legacyReportNote.hidden = !legacy;
  els.legacyOcrData.hidden = !legacy;
  if (legacy) {
    els.legacyReportNote.textContent = "This report uses the old format. OCR eval data shown below.";
    els.legacyOcrData.textContent = JSON.stringify(report.ocr_eval || {}, null, 2);
  }

  els.insightList.innerHTML = generateInsights(report).map((item) => insight(item.icon, item.tone, item.text)).join("");
  renderActions(report);
  renderFieldFilters(fields);
  renderFieldDetails(fields);
  setReportTab("summary");
  els.reportModal.hidden = false;
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
      setBanner(els.historyMessage, error.message, "error");
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
      setBanner(els.historyMessage, error.message, "error");
      showToast(error.message);
    });
}

function wireNavigation() {
  els.navItems.forEach((button) => {
    button.addEventListener("click", () => showSection(button.dataset.section));
  });
  $$("[data-section-jump]").forEach((button) => {
    button.addEventListener("click", () => showSection(button.dataset.sectionJump));
  });
}

function wireEvaluationForm() {
  addSimpleFieldRow();
  els.loadFieldsButton.addEventListener("click", loadRunFields);
  els.addFieldButton.addEventListener("click", () => {
    addSimpleFieldRow();
    els.fieldTypePicker.hidden = !els.fieldTypePicker.hidden;
  });
  els.fieldTypePicker.addEventListener("click", (event) => {
    const button = event.target.closest("[data-entry-type]");
    if (!button) return;
    addEntryByType(button.dataset.entryType);
    els.fieldTypePicker.hidden = true;
  });
  els.evalForm.addEventListener("submit", runEvaluation);
  els.extractedFieldPills.addEventListener("click", (event) => {
    const tableButton = event.target.closest("[data-table-hint]");
    if (tableButton) {
      const fieldName = tableButton.dataset.tableHint;
      const meta = state.fieldMetadata[fieldName] || {};
      addLineItemsTable({ fieldName, columns: meta.field_schema || [], rows: [] });
      return;
    }
    const pill = event.target.closest("[data-field]");
    if (!pill) return;
    addEntryByType(pill.dataset.entryType || "simple", { fieldName: pill.dataset.field, value: "" });
  });
  els.runId.addEventListener("input", () => {
    const hasEntries = entryNodes().some((entry) => entryHasContent(entry));
    if (!els.runId.value.trim() && hasEntries) {
      setBanner(els.runFieldsMessage, "Clearing run ID will keep your field entries. Change the run ID to re-run with new data.", "error");
    } else {
      clearBanner(els.runFieldsMessage);
    }
    maybeOfferRestore();
    updateRunButtonState();
  });
  els.restoreYes.addEventListener("click", restoreSessionFields);
  els.restoreNo.addEventListener("click", () => {
    els.restorePrompt.hidden = true;
  });
  els.openLatestReport.addEventListener("click", async () => {
    if (!state.currentRunReport) return;
    const name = reportName(state.currentRunReport);
    const fullReport = name ? await getReport(name).catch(() => state.currentRunReport) : state.currentRunReport;
    openReportModal(fullReport);
  });
}

function wireHistory() {
  els.historySearch.addEventListener("input", () => {
    state.historyPage = 1;
    renderHistory();
  });
  els.sortF1.addEventListener("click", () => {
    if (!state.sortByF1) {
      state.sortByF1 = true;
      state.f1SortDirection = "desc";
    } else {
      state.f1SortDirection = state.f1SortDirection === "asc" ? "desc" : "asc";
    }
    els.sortF1Indicator.textContent = state.f1SortDirection === "desc" ? "down" : "up";
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
  els.refreshReports.addEventListener("click", async () => {
    setButtonLoading(els.refreshReports, true, "Refreshing...");
    await Promise.all([loadReports(), loadSummary()]);
    setButtonLoading(els.refreshReports, false);
  });
  els.historyBody.addEventListener("click", handleReportAction);
  els.recentReportsBody.addEventListener("click", handleReportAction);
}

function wireModalAndHealth() {
  els.reportTabs.forEach((tab) => tab.addEventListener("click", () => setReportTab(tab.dataset.reportTab)));
  els.fieldFilters.addEventListener("click", (event) => {
    const button = event.target.closest("[data-field-filter]");
    if (!button || !state.activeModalReport) return;
    state.activeFieldFilter = button.dataset.fieldFilter;
    renderFieldFilters(fieldsFor(state.activeModalReport));
    renderFieldDetails(fieldsFor(state.activeModalReport));
  });
  els.downloadSummaryReport.addEventListener("click", () => {
    if (state.activeModalReport) downloadReport(state.activeModalReport);
  });
  els.closeModal.addEventListener("click", () => {
    els.reportModal.hidden = true;
  });
  els.reportModal.addEventListener("click", (event) => {
    if (event.target === els.reportModal) els.reportModal.hidden = true;
  });
  els.refreshHealth.addEventListener("click", loadHealth);
}

function init() {
  wireNavigation();
  wireEvaluationForm();
  wireHistory();
  wireModalAndHealth();
  refreshAll();
}

init();
