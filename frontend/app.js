const FIELD_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*$/;
const STARTS_WITH_NUMBER_PATTERN = /^[0-9]/;
const RESERVED_CHARS_PATTERN = /[[\]{}:'"]/;
const MAX_FIELDS = 30;
const MAX_TABLE_COLUMNS = 10;
const MAX_TABLE_ROWS = 50;
const MAX_LIST_VALUES = 50;
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
  // Live parsed JSON being edited in the schema import card. `root` is the real
  // object/array/scalar produced by JSON.parse - the editor reads and rewrites
  // it directly, so the pasted text is never re-parsed while typing. `isActive`
  // tracks whether a parse has succeeded, because `null` is itself a valid root.
  jsonEditor: { root: undefined, isActive: false },
  // The exact golden_fields payload Apply produced from the edited tree. This
  // is what the JSON preview shows and what runEvaluation POSTs - there is no
  // second, differently-shaped copy anywhere.
  goldenFields: null,
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
  schemaImportApplyButton: $("#schema-import-apply-button"),
  schemaImportApplyRow: $("#schema-import-apply-row"),
  schemaImportError: $("#schema-import-error"),
  schemaImportEditor: $("#schema-import-editor"),
  schemaImportGenerated: $("#schema-import-generated"),

  sideTabs: $$("[data-side-tab]"),
  sidePanels: $$("[data-side-panel]"),
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

  confirmDialog: $("#confirm-dialog"),
  confirmDialogMessage: $("#confirm-dialog-message"),
  confirmDialogOk: $("#confirm-dialog-ok"),
  confirmDialogCancel: $("#confirm-dialog-cancel"),

  reportModal: $("#report-modal"),
  modalCloseButton: $("#modal-close-button"),
  modalFilename: $("#modal-filename"),
  modalTitle: $("#modal-title"),
  modalRunId: $("#modal-run-id"),
  modalDocType: $("#modal-doc-type"),
  modalF1: $("#modal-f1"),
  modalPrecision: $("#modal-precision"),
  modalRecall: $("#modal-recall"),
  tabs: $$("#report-modal .tab"),
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

// In-app replacement for window.confirm() so confirmation prompts match the
// site's own styling instead of a native browser dialog. Resolves true/false.
function showConfirmDialog(message, { okLabel = "OK", cancelLabel = "Cancel", danger = false } = {}) {
  return new Promise((resolve) => {
    setText(els.confirmDialogMessage, message);
    els.confirmDialogOk.textContent = okLabel;
    els.confirmDialogOk.className = `btn ${danger ? "btn--danger" : "btn--primary"}`;
    els.confirmDialogCancel.textContent = cancelLabel;
    els.confirmDialog.classList.remove("hidden");

    const cleanup = (result) => {
      els.confirmDialog.classList.add("hidden");
      els.confirmDialogOk.removeEventListener("click", onOk);
      els.confirmDialogCancel.removeEventListener("click", onCancel);
      els.confirmDialog.removeEventListener("click", onOverlay);
      document.removeEventListener("keydown", onKeydown);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onOverlay = (event) => {
      if (event.target === els.confirmDialog) cleanup(false);
    };
    const onKeydown = (event) => {
      if (event.key === "Escape") cleanup(false);
      if (event.key === "Enter") cleanup(true);
    };

    els.confirmDialogOk.addEventListener("click", onOk);
    els.confirmDialogCancel.addEventListener("click", onCancel);
    els.confirmDialog.addEventListener("click", onOverlay);
    document.addEventListener("keydown", onKeydown);
  });
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

function hasGoldenFields() {
  const fields = state.goldenFields;
  if (!fields) return false;
  return Object.values(fields).some((value) => (isFlatObject(value) ? Object.keys(value).length > 0 : true));
}

function updateRunButtonState() {
  const hasRunId = els.runId.value.trim().length > 0;
  els.runButton.disabled = !(hasRunId && hasGoldenFields());
}

/* ---------- Schema import ---------- */

const PLACEHOLDER_VALUE_PATTERN = /^(string|string or -|-|n\/a|na|null|none|)$/i;

const CAMEL_CASE_CORRECT_DELAY = 900;

function toCamelCase(key) {
  const withWordBoundaries = String(key ?? "")
    .trim()
    // Split camelCase/PascalCase runs at internal case transitions
    // (invoiceDate -> invoice Date) before falling back to separator
    // splitting, so already-camelCase keys keep their word boundaries
    // instead of being flattened to all-lowercase.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  const words = withWordBoundaries.split(/[^a-zA-Z0-9]+/).filter(Boolean);
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

// A doctype wrapper is either a plain nested object ("invoice": {...}) or
// DocsAI's single-document-in-an-array export style ("taxInvoice": [{...}]),
// including an empty array when a document type had no example data
// ("purchaseOrder": []). Only a *single*-element array counts - multi-element
// arrays at the top level are ambiguous with genuine repeating tables and are
// left to the generic per-field table detection instead.
function isDoctypeWrapper(value) {
  if (isFlatObject(value)) return true;
  return Array.isArray(value) && value.length <= 1 && (value.length === 0 || isFlatObject(value[0]));
}

function doctypeWrapperFields(value) {
  if (isFlatObject(value)) return value;
  return value[0] || {};
}

// True once an object holds at least one array value - the signal that real
// document/line-item content has been reached, as opposed to another single-key
// envelope layer still wrapping the actual data.
function looksLikeContentLevel(obj) {
  return Object.values(obj).some((value) => Array.isArray(value));
}

// Real exports are often wrapped in one or more single-key envelopes before
// reaching the actual document types, e.g.
// { success, caseSummary: { summaryText: { taxInvoice: [...], purchaseOrder: [...] } } }.
// Drill down through those envelope layers so doctype detection runs at the
// level that actually holds the documents, instead of only ever checking the
// outermost level of the pasted JSON.
function unwrapToDoctypeLevel(obj) {
  let current = obj;
  while (isFlatObject(current)) {
    const entries = Object.entries(current);
    const relevant = entries.filter(([key]) => !DOCTYPE_METADATA_KEYS.has(String(key).toLowerCase()));
    const candidates = relevant.length ? relevant : entries;
    if (candidates.length !== 1) break;
    const [, value] = candidates[0];
    if (!isFlatObject(value)) break;
    if (looksLikeContentLevel(value)) {
      current = value;
      break;
    }
    current = value;
  }
  return current;
}

const DOCTYPE_METADATA_KEYS = new Set([
  "success",
  "extractionconfidence",
  "documenttype",
  "classifiedfiles",
  "categoryvalidationstatus",
  "categoryconfidence",
  "detectedformtype",
  "headerpattern",
  "processingtimestamp",
  "processedby",
  "service",
  "aibackend",
  "modelused",
  "usageinfo",
  "confidencescore",
  "source",
  "filename",
]);

function setSchemaImportError(message) {
  els.schemaImportError.textContent = message;
  els.schemaImportError.classList.toggle("hidden", !message);
}

// Parse only builds the live tree and paints the editor - it deliberately does
// not touch the field rows. The pasted text is left untouched on failure so a
// typo never costs the user the whole payload.
function handleParseSchema() {
  setSchemaImportError("");
  const rawText = els.schemaImportInput.value.trim();
  if (!rawText) {
    setSchemaImportError("Paste a JSON schema first.");
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    setSchemaImportError(`Invalid JSON - ${error.message}`);
    return;
  }
  state.jsonEditor.root = parsed;
  state.jsonEditor.isActive = true;
  // Parsing alone does not submit anything - drop any summary and preview from
  // a previous Apply so they can never describe a stale payload.
  clearGoldenSummary();
  state.goldenFields = null;
  renderJsonPreview();
  updateRunButtonState();
  renderJsonEditor();
}

// Apply regenerates the JSON from the live edited tree and adopts it as the
// golden fields that get submitted. Document types are kept separate - the
// backend compares each one against its own extracted document.
function handleApplySchema() {
  if (!state.jsonEditor.isActive) return;
  setSchemaImportError("");
  els.schemaImportInput.value = JSON.stringify(state.jsonEditor.root, null, 2);
  try {
    const golden = buildGoldenFieldsFromTree(state.jsonEditor.root);
    state.goldenFields = golden.fields;
    renderGoldenSummary(golden);
    renderJsonPreview();
    updateRunButtonState();
    showToast("Applied - these fields will be submitted");
  } catch (error) {
    setSchemaImportError(error.message);
  }
}

function wireSchemaImport() {
  els.schemaImportParseButton.addEventListener("click", handleParseSchema);
  els.schemaImportApplyButton.addEventListener("click", handleApplySchema);
  wireJsonEditor();
}

/* ---------- Golden fields from the edited JSON tree ---------- */

// Values are submitted as-is: strings keep their newlines, numbers/booleans are
// stringified only at the edge, and null becomes "" because the evaluator
// compares text. Nothing is merged or renamed, so what the preview shows is
// exactly what is POSTed.
function goldenScalarValue(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function goldenTableRows(rows) {
  return rows.map((row) => {
    const cells = {};
    Object.entries(row).forEach(([column, cellValue]) => {
      if (!isJsonContainer(cellValue)) cells[column] = goldenScalarValue(cellValue);
    });
    return cells;
  });
}

// Converts one document's field object into the flat field map the evaluator
// compares. Row lists stay row lists, plain lists stay plain lists.
function goldenFieldsForDocument(fieldsObj, skipped, docLabel) {
  const fields = {};
  Object.entries(fieldsObj).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      if (value.length && value.every((item) => isFlatObject(item))) {
        fields[key] = goldenTableRows(value);
        return;
      }
      if (value.some((item) => isJsonContainer(item))) {
        // Mixed or nested-array content has no flat representation the
        // evaluator can compare cell by cell.
        skipped.push(`${docLabel}${key}`);
        return;
      }
      fields[key] = value.map(goldenScalarValue);
      return;
    }
    if (isFlatObject(value)) {
      // A nested object inside a document is not a document type of its own;
      // the evaluator has no field shape for it.
      skipped.push(`${docLabel}${key}`);
      return;
    }
    fields[key] = goldenScalarValue(value);
  });
  return fields;
}

// Builds the exact golden_fields payload from the edited tree. Sibling document
// types stay separate (taxInvoice/purchaseOrder each keep their own poNo and
// lineItems) instead of being merged into one colliding flat map.
function buildGoldenFieldsFromTree(root) {
  if (!isFlatObject(root)) {
    throw new Error("The JSON must be an object at the top level.");
  }
  const unwrapped = unwrapToDoctypeLevel(root);
  const entries = Object.entries(unwrapped).filter(
    ([key]) => !DOCTYPE_METADATA_KEYS.has(String(key).toLowerCase()),
  );
  if (!entries.length) {
    throw new Error("The pasted JSON has no fields.");
  }

  const skipped = [];
  const grouped = entries.every(([, value]) => isDoctypeWrapper(value));
  if (!grouped) {
    // A single flat document - submit it flat, exactly as before.
    const fields = goldenFieldsForDocument(unwrapped, skipped, "");
    if (!Object.keys(fields).length) throw new Error("No supported fields were found in the pasted JSON.");
    return { fields, grouped: false, docTypes: [], skipped };
  }

  const fields = {};
  const docTypes = [];
  entries.forEach(([docType, wrapper]) => {
    const docFields = goldenFieldsForDocument(doctypeWrapperFields(wrapper), skipped, `${docType}.`);
    fields[docType] = docFields;
    docTypes.push({ name: docType, count: Object.keys(docFields).length });
  });
  if (!docTypes.some((doc) => doc.count)) {
    throw new Error("No supported fields were found in the pasted JSON.");
  }
  return { fields, grouped: true, docTypes, skipped };
}

function clearGoldenSummary() {
  if (!els.schemaImportGenerated) return;
  els.schemaImportGenerated.innerHTML = "";
  els.schemaImportGenerated.classList.add("hidden");
}

function renderGoldenSummary(golden) {
  if (!els.schemaImportGenerated) return;
  const parts = golden.grouped
    ? golden.docTypes.map((doc) => `${escapeHtml(doc.name)} (${doc.count} field${doc.count === 1 ? "" : "s"})`)
    : [`${Object.keys(golden.fields).length} fields`];
  let html = `<p class="schema-import-summary">Will submit: ${parts.join(", ")}.</p>`;
  if (golden.grouped) {
    html += `<p class="schema-import-summary schema-import-summary--info">Each document type is compared against its own extracted document, so same-named fields (e.g. poNo, lineItems) stay separate.</p>`;
  }
  if (golden.skipped.length) {
    html += `<p class="schema-import-summary schema-import-summary--warning">Not submitted (no comparable shape): ${escapeHtml(golden.skipped.join(", "))}.</p>`;
  }
  els.schemaImportGenerated.innerHTML = html;
  els.schemaImportGenerated.classList.remove("hidden");
}

/* ---------- JSON tree: type model + immutable path updates ---------- */

// The six JSON shapes the editor branches on. Objects and arrays are
// containers; everything else is a leaf the user edits directly.
function jsonValueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  return type === "object" ? "object" : type;
}

function isJsonContainer(value) {
  const type = jsonValueType(value);
  return type === "object" || type === "array";
}

function cloneContainer(container) {
  return Array.isArray(container) ? container.slice() : { ...container };
}

function getAtPath(root, path) {
  return path.reduce((node, key) => (node == null ? undefined : node[key]), root);
}

// Returns a new tree with `path` replaced. Every container along the way is
// copied, so no node the UI still holds a reference to is ever mutated.
function setAtPath(root, path, value) {
  if (!path.length) return value;
  const [key, ...rest] = path;
  const copy = cloneContainer(root);
  copy[key] = setAtPath(copy[key], rest, value);
  return copy;
}

// Removes exactly one key/index. Arrays splice (so later items shift down by
// one and keep contiguous indices) rather than leaving a hole; objects delete.
function deleteAtPath(root, path) {
  if (!path.length) return root;
  const parentPath = path.slice(0, -1);
  const key = path[path.length - 1];
  const parent = getAtPath(root, parentPath);
  if (!isJsonContainer(parent)) return root;
  const copy = cloneContainer(parent);
  if (Array.isArray(copy)) copy.splice(Number(key), 1);
  else delete copy[key];
  return setAtPath(root, parentPath, copy);
}

// Renames a key in place - rebuilding the object in its original order so the
// renamed field does not jump to the end. Refuses empty names and collisions
// instead of silently overwriting the existing key.
function renameKey(obj, oldKey, newKey) {
  const trimmed = String(newKey ?? "").trim();
  if (!trimmed) return { ok: false, error: "Field name cannot be empty." };
  if (trimmed === oldKey) return { ok: true, value: obj };
  if (Object.prototype.hasOwnProperty.call(obj, trimmed)) {
    return { ok: false, error: `"${trimmed}" already exists in this object.` };
  }
  const renamed = {};
  Object.entries(obj).forEach(([key, value]) => {
    renamed[key === oldKey ? trimmed : key] = value;
  });
  return { ok: true, value: renamed };
}

function defaultValueForType(type) {
  if (type === "number") return 0;
  if (type === "boolean") return false;
  if (type === "object") return {};
  if (type === "array") return [];
  return "";
}

// Builds a blank value with the same shape as `sample`, so adding a row to an
// array of line-item objects yields another object with the same columns rather
// than a bare empty string.
function emptyLikeValue(sample) {
  const type = jsonValueType(sample);
  if (type === "object") {
    const skeleton = {};
    Object.entries(sample).forEach(([key, value]) => {
      skeleton[key] = emptyLikeValue(value);
    });
    return skeleton;
  }
  if (type === "array") return [];
  return defaultValueForType(type);
}

function nextAvailableKey(obj, base = "newField") {
  if (!Object.prototype.hasOwnProperty.call(obj, base)) return base;
  let suffix = 1;
  while (Object.prototype.hasOwnProperty.call(obj, `${base}${suffix}`)) suffix += 1;
  return `${base}${suffix}`;
}

/* ---------- JSON tree editor ---------- */

function jsonPathAttr(path) {
  return escapeHtml(JSON.stringify(path));
}

function jsonPathOf(element) {
  try {
    return JSON.parse(element.dataset.jsonPath || "[]");
  } catch (error) {
    return [];
  }
}

function jsonLeafHtml(value, type, pathAttr) {
  if (type === "boolean") {
    return `
      <label class="json-leaf json-leaf--boolean">
        <input type="checkbox" data-json-leaf data-json-type="boolean" data-json-path="${pathAttr}" ${value ? "checked" : ""} />
        <span class="json-leaf__bool" data-json-bool-text>${value ? "true" : "false"}</span>
      </label>
    `;
  }
  if (type === "number") {
    return `<input class="text-input json-leaf json-leaf--number" type="number" data-json-leaf data-json-type="number" data-json-path="${pathAttr}" value="${escapeHtml(String(value))}" />`;
  }
  if (type === "null") {
    // Null keeps its own identity until the user explicitly picks a real type -
    // it is never quietly coerced into an empty string.
    return `
      <span class="json-leaf json-leaf--null">
        <span class="json-null-tag">null</span>
        <select class="json-null-select" data-json-null-type data-json-path="${pathAttr}">
          <option value="">Set value...</option>
          <option value="string">Text</option>
          <option value="number">Number</option>
          <option value="boolean">Boolean</option>
          <option value="object">Object</option>
          <option value="array">Array</option>
        </select>
      </span>
    `;
  }
  // A single-line <input> cannot render embedded newlines, so a multi-line
  // string gets a textarea. Without this the value still POSTs correctly but
  // reads as one run-together line in the editor.
  const text = String(value);
  if (text.includes("\n")) {
    return `<textarea class="textarea-input json-leaf json-leaf--text" rows="${Math.min(text.split("\n").length, 6)}" data-json-leaf data-json-type="string" data-json-path="${pathAttr}">${escapeHtml(text)}</textarea>`;
  }
  return `<input class="text-input json-leaf json-leaf--string" type="text" data-json-leaf data-json-type="string" data-json-path="${pathAttr}" value="${escapeHtml(text)}" />`;
}

// Turns a camelCase/snake_case key into a human label ("clientId" -> "Client
// ID") purely for display - the underlying key text is untouched and is what
// still shows (and is editable) in the rename input below the label.
function jsonKeyLabel(key) {
  const words = String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/);
  if (!words.length || !words[0]) return String(key);
  return words.map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join(" ");
}

// One key/index slot inside a container: a compact label/key column plus a
// recursive node for whatever value it holds, at any depth. Leaves render as
// a single label+input row; containers render their own nested block below
// the label so deep structure reads as an indented outline, not stacked cards.
function jsonKvpHtml(key, value, path, isArrayItem) {
  const pathAttr = jsonPathAttr(path);
  const childIsContainer = isJsonContainer(value);
  // The human-readable label is the primary, always-visible text. The raw
  // key stays editable via a same-styled input that is visually quiet until
  // hovered/focused, so renaming doesn't require a second control fighting
  // the label for space.
  const label = isArrayItem
    ? `<span class="json-kvp__index">${escapeHtml(String(key))}</span>`
    : `<input class="json-kvp__key" data-json-key data-json-path="${pathAttr}" type="text" value="${escapeHtml(String(key))}" title="${escapeHtml(jsonKeyLabel(key))}" autocomplete="off" spellcheck="false" />`;
  if (childIsContainer) {
    return `
      <div class="json-kvp json-kvp--container">
        <div class="json-kvp__row">
          <div class="json-kvp__label-group">${label}</div>
          <button class="json-remove-link" type="button" data-json-remove data-json-path="${pathAttr}" title="Remove ${isArrayItem ? "item" : "field"}">Remove</button>
        </div>
        ${jsonNodeHtml(value, path)}
      </div>
    `;
  }
  return `
    <div class="json-kvp">
      <div class="json-kvp__label-group">${label}</div>
      <div class="json-kvp__value">${jsonNodeHtml(value, path)}</div>
      <button class="remove-btn" type="button" data-json-remove data-json-path="${pathAttr}" title="Remove ${isArrayItem ? "item" : "field"}">&times;</button>
    </div>
  `;
}

// Recursively renders one node by type. Containers recurse into their children
// inside an indented, rail-guided block; leaves render the control matching
// their type. Depth is shown once via indentation, not via a new card border
// at every level - only an array-of-objects (e.g. line items) gets its own
// tinted sub-block, since that's the one shape dense enough to need one.
function jsonNodeHtml(value, path, options = {}) {
  const type = jsonValueType(value);
  const pathAttr = jsonPathAttr(path);
  if (!isJsonContainer(value)) {
    return `<div class="json-node json-node--leaf">${jsonLeafHtml(value, type, pathAttr)}</div>`;
  }
  const isArray = type === "array";
  const entries = isArray ? value.map((item, index) => [index, item]) : Object.entries(value);
  const noun = isArray ? "item" : "field";
  const isRoot = path.length === 0;
  const isItemGroup = isArray && entries.length > 0 && entries.every(([, item]) => isFlatObject(item));
  const wrapperClass = ["json-node", `json-node--${type}`, isRoot ? "json-node--root" : "", isItemGroup ? "json-node--item-group" : ""]
    .filter(Boolean)
    .join(" ");
  const body = entries.length
    ? `<div class="json-node__children">${entries.map(([key, child]) => jsonKvpHtml(key, child, [...path, key], isArray)).join("")}</div>`
    : `<p class="json-node__empty">Empty ${isArray ? "array" : "object"} - nothing to edit yet.</p>`;
  const countLabel = options.hideCount ? "" : `<span class="json-node__count">${entries.length} ${noun}${entries.length === 1 ? "" : "s"}</span>`;
  return `
    <div class="${wrapperClass}">
      ${isRoot ? "" : `<div class="json-node__rail"></div>`}
      <div class="json-node__body">
        <div class="json-node__head">
          ${countLabel}
          <button class="json-add-link" type="button" data-json-add data-json-path="${pathAttr}">+ Add ${noun}</button>
        </div>
        ${body}
      </div>
    </div>
  `;
}

function captureJsonEditorFocus() {
  const active = document.activeElement;
  if (!active || !els.schemaImportEditor.contains(active)) return null;
  return {
    path: active.dataset.jsonPath || "",
    selector: active.hasAttribute("data-json-key") ? "[data-json-key]" : "[data-json-leaf]",
  };
}

function restoreJsonEditorFocus(focus) {
  if (!focus) return;
  const match = Array.from(els.schemaImportEditor.querySelectorAll(focus.selector))
    .find((element) => element.dataset.jsonPath === focus.path);
  if (match) match.focus();
}

function renderJsonEditor() {
  if (!els.schemaImportEditor) return;
  const { root, isActive } = state.jsonEditor;
  els.schemaImportEditor.classList.toggle("hidden", !isActive);
  els.schemaImportApplyRow.classList.toggle("hidden", !isActive);
  if (!isActive) {
    els.schemaImportEditor.innerHTML = "";
    return;
  }
  const focus = captureJsonEditorFocus();
  els.schemaImportEditor.innerHTML = jsonNodeHtml(root, []);
  restoreJsonEditorFocus(focus);
}

// Structural edits (add/remove/rename/retype) swap in a new tree and repaint.
// Leaf edits deliberately skip the repaint - see onJsonEditorInput.
function replaceJsonTree(nextRoot) {
  state.jsonEditor.root = nextRoot;
  renderJsonEditor();
}

function handleJsonAdd(path) {
  const target = getAtPath(state.jsonEditor.root, path);
  if (Array.isArray(target)) {
    // Infer the new item from the existing first element, falling back to text
    // for an empty array, so item type is preserved instead of always defaulting.
    const nextItem = target.length ? emptyLikeValue(target[0]) : "";
    replaceJsonTree(setAtPath(state.jsonEditor.root, path, [...target, nextItem]));
    return;
  }
  if (isFlatObject(target)) {
    replaceJsonTree(setAtPath(state.jsonEditor.root, path, { ...target, [nextAvailableKey(target)]: "" }));
  }
}

function handleJsonRename(input) {
  const path = jsonPathOf(input);
  const parentPath = path.slice(0, -1);
  const oldKey = path[path.length - 1];
  const parent = getAtPath(state.jsonEditor.root, parentPath);
  if (!isFlatObject(parent)) return;
  const result = renameKey(parent, oldKey, input.value);
  if (!result.ok) {
    input.value = oldKey;
    input.classList.add("is-invalid");
    showToast(result.error);
    return;
  }
  input.classList.remove("is-invalid");
  replaceJsonTree(setAtPath(state.jsonEditor.root, parentPath, result.value));
}

// Leaf typing writes straight into the tree without repainting, so the caret
// and selection survive every keystroke.
function onJsonEditorInput(event) {
  const leaf = event.target.closest("[data-json-leaf]");
  if (!leaf) return;
  const path = jsonPathOf(leaf);
  if (leaf.dataset.jsonType === "number") {
    // Cast back to a real number. A half-typed or empty entry is flagged and
    // held rather than written through as a string.
    const isValid = leaf.value.trim() !== "" && Number.isFinite(Number(leaf.value));
    leaf.classList.toggle("is-invalid", !isValid);
    if (isValid) state.jsonEditor.root = setAtPath(state.jsonEditor.root, path, Number(leaf.value));
    return;
  }
  if (leaf.dataset.jsonType === "string") {
    state.jsonEditor.root = setAtPath(state.jsonEditor.root, path, leaf.value);
  }
}

function onJsonEditorChange(event) {
  const target = event.target;
  if (target.matches('[data-json-leaf][data-json-type="boolean"]')) {
    state.jsonEditor.root = setAtPath(state.jsonEditor.root, jsonPathOf(target), target.checked);
    const label = target.parentElement.querySelector("[data-json-bool-text]");
    if (label) label.textContent = target.checked ? "true" : "false";
    return;
  }
  if (target.matches("[data-json-null-type]") && target.value) {
    replaceJsonTree(setAtPath(state.jsonEditor.root, jsonPathOf(target), defaultValueForType(target.value)));
    return;
  }
  // Renames apply on commit, not per keystroke, so a half-typed name is never
  // treated as a collision.
  if (target.matches("[data-json-key]")) handleJsonRename(target);
}

function onJsonEditorClick(event) {
  const addButton = event.target.closest("[data-json-add]");
  if (addButton) {
    handleJsonAdd(jsonPathOf(addButton));
    return;
  }
  const removeButton = event.target.closest("[data-json-remove]");
  if (removeButton) replaceJsonTree(deleteAtPath(state.jsonEditor.root, jsonPathOf(removeButton)));
}

// Delegated once on the container - nodes at any depth are handled without
// re-wiring listeners on every repaint.
function wireJsonEditor() {
  if (!els.schemaImportEditor) return;
  els.schemaImportEditor.addEventListener("input", onJsonEditorInput);
  els.schemaImportEditor.addEventListener("change", onJsonEditorChange);
  els.schemaImportEditor.addEventListener("click", onJsonEditorClick);
}

/* ---------- JSON preview ---------- */

// Shows the exact golden_fields object that will be POSTed - the same value
// runEvaluation sends, rendered verbatim. Nothing is re-derived or reshaped
// here, so the preview can never disagree with what is submitted.
function renderJsonPreview() {
  if (!els.jsonPreviewOutput) return;
  const fields = state.goldenFields;
  const isEmpty = !fields || !Object.keys(fields).length;
  els.jsonPreviewOutput.classList.toggle("hidden", isEmpty);
  els.jsonPreviewEmpty.classList.toggle("hidden", !isEmpty);
  if (!isEmpty) els.jsonPreviewOutput.textContent = JSON.stringify(fields, null, 2);
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

// Restores the saved JSON tree back into the editor, then re-derives the
// golden fields from it - so a restored session goes through exactly the same
// path as a fresh paste and cannot drift from what would be submitted.
function restoreSessionFields() {
  const key = restoreStorageKey();
  if (!key) return;
  const raw = sessionStorage.getItem(key);
  if (!raw) return;
  try {
    const savedTree = JSON.parse(raw);
    state.jsonEditor.root = savedTree;
    state.jsonEditor.isActive = true;
    els.schemaImportInput.value = JSON.stringify(savedTree, null, 2);
    renderJsonEditor();
    const golden = buildGoldenFieldsFromTree(savedTree);
    state.goldenFields = golden.fields;
    renderGoldenSummary(golden);
    renderJsonPreview();
    updateRunButtonState();
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
  const fields = state.goldenFields;
  if (!els.runId.value.trim()) {
    setBanner(els.runMessageBanner, "Enter a DocsAI Run ID before running evaluation.", "error");
    return;
  }
  if (!hasGoldenFields()) {
    setBanner(els.runMessageBanner, "Paste a JSON schema, click Parse, then Apply before running evaluation.", "error");
    return;
  }
  setResultStatus("RUNNING", "warning");
  setButtonLoading(els.runButton, true, "Running evaluation...");
  startProgressMessages();
  try {
    const runId = els.runId.value.trim();
    const report = await api.runEvaluation({ run_id: runId, golden_fields: fields });
    saveSessionFields(runId, state.jsonEditor.root);
    rememberCurrentRun(report);
    renderRunResult(report);
    renderLatest(report);
    setResultStatus("COMPLETE", "success");
    setBanner(els.runMessageBanner, "Evaluation completed successfully.", "success");
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
    const confirmed = await showConfirmDialog(`Delete report ${name}?`, { okLabel: "Delete", danger: true });
    if (!confirmed) return;
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
    return "<div class=\"ocr-action-hint ocr-action-hint--ocr\">OCR did not capture this. Prompt changes will not fix it.</div>";
  }
  return '<div class="ocr-action-hint ocr-action-hint--uncertain">Needs manual review of the source document</div>';
}

function renderOcrAccordion(result) {
  const search = result.ocr_search;
  if (!search) return "";
  const verdict = String(search.verdict || "UNCERTAIN").toUpperCase();
  const verdictClass = verdict.toLowerCase();
  const badgeClass = verdict === "PROMPT_PROBLEM" ? "badge--warning" : verdict === "OCR_LIMITATION" ? "badge--error" : "badge--muted";
  const verdictLabel = verdict === "UNCERTAIN" ? "UNCERTAIN — needs manual review" : verdict.replaceAll("_", " ");
  const occurrences = Number(search.occurrence_count || 0);
  const pagesSearched = Number(search.search_results?.pages_searched || 0);
  const pagesLine = pagesSearched > 1 ? `<small>Searched ${pagesSearched} pages</small>` : "";
  return `
    <details class="ocr-accordion ocr-accordion--${verdictClass}">
      <summary>
        <span class="badge ${badgeClass}">${escapeHtml(verdictLabel)}</span>
        OCR diagnosis
      </summary>
      <p class="ocr-diagnosis-reason">${escapeHtml(search.reason || "-")}</p>
      <small>Found in OCR: ${occurrences} time(s)</small>
      ${pagesLine}
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

// Adds a field from the "detected fields" hints into the edited JSON tree.
// Everything funnels through the same tree the editor renders, so a hint-added
// field is submitted identically to a pasted one.
function addDetectedFieldToTree(fieldName, blankValue) {
  if (!state.jsonEditor.isActive || !isFlatObject(state.jsonEditor.root)) {
    state.jsonEditor.root = {};
    state.jsonEditor.isActive = true;
  }
  const root = state.jsonEditor.root;
  // With grouped doctypes there is no single obvious parent, so add to the
  // first document type when one exists, otherwise at the top level.
  const [firstDocType] = Object.entries(root)
    .filter(([key]) => !DOCTYPE_METADATA_KEYS.has(String(key).toLowerCase()))
    .filter(([, value]) => isDoctypeWrapper(value))
    .map(([key]) => key);
  const path = firstDocType
    ? [firstDocType, ...(Array.isArray(root[firstDocType]) ? [0] : []), fieldName]
    : [fieldName];
  replaceJsonTree(setAtPath(state.jsonEditor.root, path, blankValue));
  els.schemaImportInput.value = JSON.stringify(state.jsonEditor.root, null, 2);
  showToast(`Added ${fieldName} - click Apply to submit it`);
}

function wireEvaluationForm() {
  wireSidePanelTabs();
  wireSchemaImport();
  els.loadFieldsButton.addEventListener("click", loadRunFields);
  els.evalForm.addEventListener("submit", runEvaluation);
  els.extractedFieldPills.addEventListener("click", (event) => {
    const tableButton = event.target.closest("[data-table-hint]");
    if (tableButton) {
      const fieldName = tableButton.dataset.tableHint;
      const meta = state.fieldMetadata[fieldName] || {};
      const columns = meta.field_schema || [];
      const blankRow = Object.fromEntries(columns.map((column) => [column, ""]));
      addDetectedFieldToTree(fieldName, columns.length ? [blankRow] : []);
      return;
    }
    const pill = event.target.closest("[data-field]");
    if (!pill) return;
    addDetectedFieldToTree(pill.dataset.field, "");
  });
  els.runId.addEventListener("input", () => {
    if (!els.runId.value.trim() && hasGoldenFields()) {
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
