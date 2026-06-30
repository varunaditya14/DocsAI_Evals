const state = {
  reports: [],
  reportCache: new Map(),
  sortByF1: false,
  f1SortDirection: "desc",
  historyPage: 1,
  historyPageSize: 5,
  latestReport: null,
  currentRunReport: null,
  activeModalReport: null,
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
  averageRecall: $("#averageRecall"),
  worstField: $("#worstField"),
  latestReportLabel: $("#latestReportLabel"),
  latestPrecision: $("#latestPrecision"),
  latestRecall: $("#latestRecall"),
  latestF1: $("#latestF1"),
  latestMissing: $("#latestMissing"),
  recentReportsBody: $("#recentReportsBody"),
  goldenForm: $("#goldenForm"),
  goldenFile: $("#goldenFile"),
  dropzone: $("#dropzone"),
  browseGolden: $("#browseGolden"),
  goldenFileName: $("#goldenFileName"),
  currentGdsFile: $("#currentGdsFile"),
  goldenStatus: $("#goldenStatus"),
  goldenMessage: $("#goldenMessage"),
  uploadGoldenButton: $("#uploadGoldenButton"),
  evalForm: $("#evalForm"),
  runId: $("#runId"),
  filename: $("#filename"),
  documentType: $("#documentType"),
  runStatus: $("#runStatus"),
  runMessage: $("#runMessage"),
  runButton: $("#runButton"),
  testOcrOnly: $("#testOcrOnly"),
  testLlmOnly: $("#testLlmOnly"),
  debugOutputPanel: $("#debugOutputPanel"),
  debugOutputTitle: $("#debugOutputTitle"),
  debugOutputPre: $("#debugOutputPre"),
  closeDebugOutput: $("#closeDebugOutput"),
  resultSubtitle: $("#resultSubtitle"),
  resultStatus: $("#resultStatus"),
  resultRunId: $("#resultRunId"),
  resultFilename: $("#resultFilename"),
  resultPrecision: $("#resultPrecision"),
  resultRecall: $("#resultRecall"),
  resultF1: $("#resultF1"),
  resultOcrF1: $("#resultOcrF1"),
  resultOcrPrecision: $("#resultOcrPrecision"),
  resultOcrRecall: $("#resultOcrRecall"),
  resultOcrMissing: $("#resultOcrMissing"),
  resultOcrFields: $("#resultOcrFields"),
  resultLlmF1: $("#resultLlmF1"),
  resultLlmPrecision: $("#resultLlmPrecision"),
  resultLlmRecall: $("#resultLlmRecall"),
  resultLlmTp: $("#resultLlmTp"),
  resultLlmFp: $("#resultLlmFp"),
  resultLlmFn: $("#resultLlmFn"),
  resultLlmGrey: $("#resultLlmGrey"),
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
  healthGdsPath: $("#healthGdsPath"),
  healthResultsPath: $("#healthResultsPath"),
  healthOpenAi: $("#healthOpenAi"),
  toast: $("#toast"),
  reportModal: $("#reportModal"),
  closeModal: $("#closeModal"),
  modalTitle: $("#modalTitle"),
  modalSubtitle: $("#modalSubtitle"),
  modalRunId: $("#modalRunId"),
  modalFilename: $("#modalFilename"),
  combinedModalF1: $("#combinedModalF1"),
  combinedModalPrecision: $("#combinedModalPrecision"),
  combinedModalRecall: $("#combinedModalRecall"),
  ocrModalF1: $("#ocrModalF1"),
  ocrModalPrecision: $("#ocrModalPrecision"),
  ocrModalRecall: $("#ocrModalRecall"),
  ocrMissingCount: $("#ocrMissingCount"),
  ocrAddedCount: $("#ocrAddedCount"),
  ocrFieldResultsBody: $("#ocrFieldResultsBody"),
  llmSection: $("#llmSection"),
  legacyLlmNote: $("#legacyLlmNote"),
  llmModalF1: $("#llmModalF1"),
  llmModalPrecision: $("#llmModalPrecision"),
  llmModalRecall: $("#llmModalRecall"),
  llmTp: $("#llmTp"),
  llmFp: $("#llmFp"),
  llmFn: $("#llmFn"),
  llmGrey: $("#llmGrey"),
  llmFieldResultsBody: $("#llmFieldResultsBody"),
  reportTabs: $$(".modal-tab"),
  reportPanels: $$(".report-tab-panel"),
  comparisonGrid: $("#comparisonGrid"),
  summaryLlmNote: $("#summaryLlmNote"),
  attentionList: $("#attentionList"),
  downloadSummaryReport: $("#downloadSummaryReport"),
  viewBreakdownButton: $("#viewBreakdownButton"),
};

const api = {
  async request(path, options = {}) {
    const response = await fetch(path, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload.detail || `Request failed with HTTP ${response.status}`;
      const message = typeof detail === "string" ? detail : detail.message || `Request failed with HTTP ${response.status}`;
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
  uploadGolden(formData, duplicateAction = "reject") {
    const query = new URLSearchParams({ duplicate_action: duplicateAction });
    return this.request(`/api/golden/upload?${query.toString()}`, { method: "POST", body: formData });
  },
  runEvaluation(body) {
    return this.request("/api/evaluations/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },
  runFullEvaluation(body) {
    return this.request("/api/evaluations/run/full", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },
  runOcrEvaluation(body) {
    return this.request("/api/evaluations/ocr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },
  runLlmEvaluation(body) {
    return this.request("/api/evaluations/llm", {
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

function formatScore(value) {
  return typeof value === "number" ? value.toFixed(4) : "-";
}

function setText(element, value) {
  if (element) element.textContent = value;
}

function setHidden(element, hidden) {
  if (element) element.hidden = hidden;
}

function setClassName(element, value) {
  if (element) element.className = value;
}

function setBanner(element, message, type = "error") {
  element.textContent = message;
  element.className = `banner ${type}`;
  element.hidden = false;
}

function clearBanner(element) {
  element.textContent = "";
  element.hidden = true;
}

function setButtonLoading(button, isLoading, label) {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = isLoading;
  button.textContent = isLoading ? label : button.dataset.label;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  window.setTimeout(() => els.toast.classList.remove("show"), 2800);
}

function statusClass(status) {
  const normalized = String(status || "").toUpperCase();
  if (["TP", "PASS", "COMPLETED"].includes(normalized)) return "completed";
  if (["FP", "FAIL", "FAILED"].includes(normalized)) return "failed";
  if (["FN", "MISSING"].includes(normalized)) return "missing";
  if (["GREY", "UNRESOLVED", "UNCERTAIN"].includes(normalized)) return "unresolved";
  return "partial";
}

function statusLabel(status) {
  const normalized = String(status || "").toUpperCase();
  if (normalized === "TP") return "PASS";
  if (normalized === "FP") return "FAIL";
  if (normalized === "FN") return "MISSING";
  if (normalized === "GREY") return "UNCERTAIN";
  return normalized || "PARTIAL";
}

function statusPill(status) {
  return `<span class="status-pill ${statusClass(status)}">${escapeHtml(statusLabel(status))}</span>`;
}

function reportName(report) {
  return report.report_name || report.report_filename || report.name || "";
}

function rememberCurrentRun(report) {
  state.currentRunReport = report;
  state.latestReport = report;
  const name = reportName(report);
  if (name) state.reportCache.set(name, report);
}

function reportRunTime(report) {
  const modified = Number(report.modified || 0);
  if (modified) return modified;
  const timestamp = String(report.timestamp || "");
  const compactTimestamp = timestamp.match(/^(\d{8})_(\d{6})$/);
  if (compactTimestamp) {
    const [, datePart, timePart] = compactTimestamp;
    const parsed = Date.parse(
      `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}T${timePart.slice(0, 2)}:${timePart.slice(2, 4)}:${timePart.slice(4, 6)}Z`,
    );
    return Number.isNaN(parsed) ? 0 : parsed / 1000;
  }
  return 0;
}

function ocrEval(report) {
  if (report.ocr_eval?.diff_result || report.ocr_eval?.f1_scores) return report.ocr_eval;
  if (report.ocr_eval?.f1 !== undefined) {
    return {
      diff_result: { total_missing: report.ocr_eval.missing_lines ?? 0, total_added: 0 },
      jiwer_result: {},
      fuzz_result: {},
      f1_scores: {
        f1: report.ocr_eval.f1,
        precision: report.ocr_eval.precision,
        recall: report.ocr_eval.recall,
      },
      field_count: report.ocr_eval.field_count,
    };
  }
  return {
    diff_result: report.diff_result || {},
    jiwer_result: report.jiwer_result || {},
    fuzz_result: report.fuzz_result || {},
    f1_scores: report.f1_scores || report.ocr_eval || {},
  };
}

function ocrScores(report) {
  return ocrEval(report).f1_scores || report.ocr_eval || {};
}

function hasObjectEntries(value) {
  return value && typeof value === "object" && Object.keys(value).length > 0;
}

function llmEval(report) {
  if (!report.llm_eval) return null;
  if (hasObjectEntries(report.llm_eval.field_comparison) || hasObjectEntries(report.llm_eval.f1_scores)) {
    return report.llm_eval;
  }
  return null;
}

function llmScores(report) {
  if (report.llm_eval?.f1_scores) return report.llm_eval.f1_scores;
  if (report.llm_eval?.f1 !== undefined) return report.llm_eval;
  return {};
}

function combinedScores(report) {
  if (report.evals_report) return report.evals_report;
  if (report.combined) return report.combined;
  const llm = llmScores(report);
  if (Object.keys(llm).length && !Object.keys(ocrScores(report)).length) {
    return {
      f1: llm.f1,
      precision: llm.precision,
      recall: llm.recall,
    };
  }
  const scores = ocrScores(report);
  return {
    f1: scores.f1,
    precision: scores.precision,
    recall: scores.recall,
  };
}

function statusRowClass(status) {
  return `status-row ${statusClass(status)}`;
}

function isProblemStatus(status) {
  return ["FP", "FN"].includes(String(status || "").toUpperCase());
}

function isGreyStatus(status) {
  return String(status || "").toUpperCase() === "GREY";
}

function setReportTab(tabName) {
  els.reportTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.reportTab === tabName);
  });
  els.reportPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.reportPanel === tabName);
  });
}

function comparisonRow(label, value) {
  return `<div class="comparison-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderComparisonCard(kind, scoreData, detailRows) {
  const iconClass = kind === "ocr" ? "ti ti-scan" : "ti ti-braces";
  const label = kind === "ocr" ? "OCR eval" : "LLM eval";
  return `
    <article class="comparison-card">
      <div class="comparison-card-title">
        <span class="${iconClass}" aria-hidden="true"></span>
        <strong>${label}</strong>
      </div>
      <div class="comparison-score">
        <strong>${formatScore(scoreData.f1)}</strong>
        <span>F1 score</span>
      </div>
      <div class="comparison-divider"></div>
      ${comparisonRow("Precision", formatScore(scoreData.precision))}
      ${comparisonRow("Recall", formatScore(scoreData.recall))}
      <div class="comparison-divider"></div>
      ${detailRows.join("")}
    </article>
  `;
}

function buildAttentionList(report) {
  const ocr = ocrEval(report);
  const llm = llmEval(report);
  const fuzz = ocr.fuzz_result || {};
  const jiwer = ocr.jiwer_result || {};
  const llmComparison = llm?.field_comparison || {};
  const fields = new Set([...Object.keys(fuzz), ...Object.keys(llmComparison)]);

  return [...fields]
    .map((field) => {
      const ocrResult = fuzz[field];
      const llmResult = llmComparison[field];
      const ocrStatus = ocrResult?.status;
      const llmStatus = llmResult?.status;
      const ocrProblem = isProblemStatus(ocrStatus);
      const llmProblem = isProblemStatus(llmStatus);
      const hasGrey = isGreyStatus(ocrStatus) || isGreyStatus(llmStatus);

      if (!llm && !ocrProblem && !hasGrey) return null;
      if (ocrStatus === "TP" && llmStatus === "TP") return null;
      if (!ocrProblem && !llmProblem && !hasGrey && ocrStatus && llmStatus) return null;

      let tag = "";
      if (ocrProblem && llmProblem) tag = "OCR + LLM";
      else if (ocrProblem) tag = "OCR only";
      else if (llmProblem) tag = "LLM only";
      else tag = "Review";
      if (hasGrey) tag = `${tag}, GREY`;

      const missingIn = [];
      if (!ocrResult) missingIn.push("OCR eval");
      if (!llmResult && llm) missingIn.push("LLM eval");

      let reason = "";
      if (missingIn.length) {
        reason = `Missing in ${missingIn.join(" and ")}`;
      } else if (hasGrey) {
        reason = "Formatting differs, content matches - needs manual review";
      } else if (ocrProblem && jiwer[field]) {
        reason = "Character mismatch";
      } else if (llmProblem) {
        reason = "Value mismatch";
      } else {
        reason = "Needs review";
      }

      let severity = "single";
      if (ocrProblem && llmProblem) severity = "both";
      if (hasGrey && !ocrProblem && !llmProblem) severity = "grey";
      else if (hasGrey) severity = "mixed-grey";

      return { field, tag, reason, severity };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const order = { both: 0, "mixed-grey": 1, single: 2, grey: 3 };
      return (order[a.severity] ?? 4) - (order[b.severity] ?? 4);
    });
}

function renderSummaryTab(report) {
  const ocr = ocrEval(report);
  const llm = llmEval(report);
  const ocrScore = ocr.f1_scores || {};
  const ocrResults = Object.values(ocr.fuzz_result || {});
  const ocrTp = ocrResults.filter((result) => result?.status === "TP").length;
  const ocrTotal = ocrResults.length;
  const missingLines = ocr.diff_result?.total_missing ?? 0;

  const cards = [
    renderComparisonCard("ocr", ocrScore, [
      comparisonRow("Missing lines", String(missingLines)),
      comparisonRow("Fields passed", `${ocrTp} / ${ocrTotal}`),
    ]),
  ];

  if (llm) {
    const llmScore = llm.f1_scores || {};
    const issues = Number(llmScore.fp || 0) + Number(llmScore.fn || 0);
    cards.push(
      renderComparisonCard("llm", llmScore, [
        comparisonRow("True positive", String(llmScore.tp ?? 0)),
        comparisonRow("Issues / Uncertain", `${issues} / ${llmScore.grey_count ?? 0}`),
      ]),
    );
  }

  els.comparisonGrid.classList.toggle("single-card", !llm);
  els.comparisonGrid.innerHTML = cards.join("");
  els.summaryLlmNote.hidden = Boolean(llm);

  const attentionItems = buildAttentionList(report);
  if (!attentionItems.length) {
    els.attentionList.innerHTML = `
      <div class="empty-success-state">
        <span class="ti ti-circle-check" aria-hidden="true"></span>
        <strong>All fields passed in both evals</strong>
      </div>
    `;
    return;
  }

  els.attentionList.innerHTML = attentionItems
    .map((item) => `
      <div class="attention-row ${item.severity}">
        <span class="attention-tag ${item.severity}">${escapeHtml(item.tag)}</span>
        <strong class="attention-field">${escapeHtml(item.field)}</strong>
        <span class="attention-reason">${escapeHtml(item.reason)}</span>
      </div>
    `)
    .join("");
}

function overallStatus(report) {
  const llm = llmScores(report);
  const ocr = ocrScores(report);
  if ((ocr.unresolved_count || 0) > 0 || (llm.grey_count || 0) > 0) return "PARTIAL";
  if (report.status) return report.status;
  if (report.eval_type || report.report_name || report.report_filename || report.name) return "COMPLETED";
  return "FAILED";
}

function showSection(sectionId) {
  els.views.forEach((view) => view.classList.toggle("active", view.id === sectionId));
  els.navItems.forEach((item) => item.classList.toggle("active", item.dataset.section === sectionId));
}

function filteredReports() {
  const query = els.historySearch.value.trim().toLowerCase();
  const direction = state.f1SortDirection === "asc" ? 1 : -1;
  return [...state.reports]
    .filter((report) => {
      if (!query) return true;
      return [report.name, report.run_id, report.filename].some((value) =>
        String(value || "").toLowerCase().includes(query),
      );
    })
    .sort((a, b) => {
      if (!state.sortByF1) {
        return reportRunTime(b) - reportRunTime(a);
      }
      const af1 = typeof combinedScores(a).f1 === "number" ? combinedScores(a).f1 : -1;
      const bf1 = typeof combinedScores(b).f1 === "number" ? combinedScores(b).f1 : -1;
      return (af1 - bf1) * direction;
    });
}

function reportActionButtons(reportName) {
  const safeName = escapeHtml(reportName);
  return `
    <button class="icon-action" type="button" data-action="view" data-report="${safeName}" title="View report" aria-label="View report">
      <svg viewBox="0 0 24 24"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" /><circle cx="12" cy="12" r="3" /></svg>
    </button>
    <button class="icon-action" type="button" data-action="download" data-report="${safeName}" title="Download JSON" aria-label="Download JSON">
      <svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
    </button>
  `;
}

function renderRecentReports() {
  const reports = state.reports.slice(0, 5);
  if (!reports.length) {
    els.recentReportsBody.innerHTML = '<tr><td colspan="6" class="empty-row">No reports saved yet</td></tr>';
    return;
  }
  els.recentReportsBody.innerHTML = reports
    .map((report) => {
      const scores = combinedScores(report);
      return `
        <tr>
          <td>${escapeHtml(reportName(report))}</td>
          <td>${escapeHtml(report.run_id || "-")}</td>
          <td>${escapeHtml(report.filename || "-")}</td>
          <td>${formatScore(scores.f1)}</td>
          <td>${statusPill(overallStatus(report))}</td>
          <td>${reportActionButtons(reportName(report))}</td>
        </tr>
      `;
    })
    .join("");
}

function renderHistory() {
  const reports = filteredReports();
  els.reportCount.textContent = `${reports.length} report${reports.length === 1 ? "" : "s"}`;
  els.sortF1Indicator.textContent = state.sortByF1 ? (state.f1SortDirection === "asc" ? "up" : "down") : "sort";
  const totalPages = Math.max(1, Math.ceil(reports.length / state.historyPageSize));
  state.historyPage = Math.min(Math.max(state.historyPage, 1), totalPages);

  if (!reports.length) {
    els.historyBody.innerHTML = '<tr><td colspan="7" class="empty-row">No reports found</td></tr>';
    if (els.historyPageLabel) els.historyPageLabel.textContent = "Page 0 of 0";
    if (els.historyPrev) els.historyPrev.disabled = true;
    if (els.historyNext) els.historyNext.disabled = true;
    return;
  }

  const start = (state.historyPage - 1) * state.historyPageSize;
  const pageReports = reports.slice(start, start + state.historyPageSize);
  if (els.historyPageLabel) els.historyPageLabel.textContent = `Page ${state.historyPage} of ${totalPages}`;
  if (els.historyPrev) els.historyPrev.disabled = state.historyPage <= 1;
  if (els.historyNext) els.historyNext.disabled = state.historyPage >= totalPages;

  els.historyBody.innerHTML = pageReports
    .map((report) => {
      const scores = combinedScores(report);
      const ocr = ocrScores(report);
      const llm = llmScores(report);
      return `
        <tr>
          <td>${escapeHtml(reportName(report))}</td>
          <td>${escapeHtml(report.filename || "-")}</td>
          <td>${formatScore(scores.f1)}</td>
          <td>${formatScore(ocr.f1)}</td>
          <td>${formatScore(llm.f1)}</td>
          <td>${statusPill(overallStatus(report))}</td>
          <td>${reportActionButtons(reportName(report))}</td>
        </tr>
      `;
    })
    .join("");
}

function renderSummary(summary) {
  setText(els.totalRuns, summary.total_runs ?? 0);
  setText(els.averageF1, formatScore(summary.average_f1));
  setText(els.averageRecall, formatScore(summary.average_recall));
  setText(els.worstField, summary.worst_field || "-");
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
  const scores = combinedScores(report);
  const diff = ocrEval(report).diff_result || {};
  setText(els.latestReportLabel, report.filename || reportName(report));
  setText(els.latestPrecision, formatScore(scores.precision));
  setText(els.latestRecall, formatScore(scores.recall));
  setText(els.latestF1, formatScore(scores.f1));
  setText(els.latestMissing, diff.total_missing ?? report.ocr_eval?.missing_lines ?? "-");
}

function renderRunResult(report) {
  const scores = combinedScores(report);
  const ocr = ocrScores(report);
  const ocrInfo = ocrEval(report);
  const llm = llmScores(report);
  setText(els.resultSubtitle, reportName(report) || "Evaluation completed");
  setText(els.resultStatus, "COMPLETED");
  setClassName(els.resultStatus, "status-pill completed");
  setText(els.resultRunId, report.run_id || "-");
  setText(els.resultFilename, report.filename || "-");
  setText(els.resultPrecision, formatScore(scores.precision));
  setText(els.resultRecall, formatScore(scores.recall));
  setText(els.resultF1, formatScore(scores.f1));
  setText(els.resultOcrF1, formatScore(ocr.f1));
  setText(els.resultOcrPrecision, formatScore(ocr.precision));
  setText(els.resultOcrRecall, formatScore(ocr.recall));
  setText(els.resultOcrMissing, ocrInfo.diff_result?.total_missing ?? report.ocr_eval?.missing_lines ?? "-");
  setText(els.resultOcrFields, ocrInfo.field_count ?? report.ocr_eval?.field_count ?? Object.keys(ocrInfo.fuzz_result || {}).length);
  setText(els.resultLlmF1, formatScore(llm.f1));
  setText(els.resultLlmPrecision, formatScore(llm.precision));
  setText(els.resultLlmRecall, formatScore(llm.recall));
  setText(els.resultLlmTp, llm.tp ?? "-");
  setText(els.resultLlmFp, llm.fp ?? "-");
  setText(els.resultLlmFn, llm.fn ?? "-");
  setText(els.resultLlmGrey, llm.grey_count ?? "-");
  if (els.openLatestReport) els.openLatestReport.disabled = false;
}

function evaluationRequestBody() {
  return {
    run_id: els.runId.value.trim(),
    filename: els.filename.value.trim(),
  };
}

function validateEvaluationInputs() {
  if (!els.runId.value.trim() || !els.filename.value.trim()) {
    setBanner(els.runMessage, "Enter a DocsAI Run ID and GDS Filename before testing.", "error");
    return false;
  }
  return true;
}

function showDebugOutput(title, data) {
  els.debugOutputTitle.textContent = title;
  els.debugOutputPre.textContent = JSON.stringify(data, null, 2);
  els.debugOutputPanel.hidden = false;
}

function goldenUploadFormData(file) {
  const formData = new FormData();
  formData.append("file", file);
  return formData;
}

function renderGoldenUploadSuccess(result) {
  els.currentGdsFile.textContent = `${result.filename} (${result.records} records, ${result.total_available_filenames ?? result.available_filenames?.length ?? result.records} total available)`;
  els.goldenStatus.textContent = "COMPLETED";
  els.goldenStatus.className = "status-pill completed";
  const actionText = result.stored_action === "overwritten" ? "Replaced existing GDS file" : "Saved GDS file";
  setBanner(els.goldenMessage, `${actionText}: ${result.filename}.`, "success");
  showToast("Golden dataset uploaded");
}

async function runDebugEvaluation(kind) {
  if (!validateEvaluationInputs()) return;
  clearBanner(els.runMessage);
  const isOcr = kind === "ocr";
  const button = isOcr ? els.testOcrOnly : els.testLlmOnly;
  setButtonLoading(button, true, "Testing...");
  try {
    const data = isOcr
      ? await api.runOcrEvaluation(evaluationRequestBody())
      : await api.runLlmEvaluation(evaluationRequestBody());
    showDebugOutput(isOcr ? "OCR Eval Debug Output" : "LLM Eval Debug Output", data);
    rememberCurrentRun(data);
    renderRunResult(data);
    renderLatest(data);
    await Promise.all([loadSummary(), loadReports()]);
  } catch (error) {
    setBanner(els.runMessage, error.message, "error");
  } finally {
    setButtonLoading(button, false);
  }
}

async function loadHealth() {
  clearBanner(els.healthMessage);
  els.apiBaseUrl.textContent = window.location.origin;
  try {
    const health = await api.health();
    els.topHealthDot.className = "health-dot ok";
    els.topHealthText.textContent = "Backend connected";
    els.dashboardHealthPill.textContent = "COMPLETED";
    els.dashboardHealthPill.className = "status-pill completed";
    els.healthStatus.textContent = health.status || "ok";
    els.healthGdsPath.textContent = health.gds_path || "Not returned by backend";
    els.healthResultsPath.textContent = health.results_path || "Not returned by backend";
    els.healthOpenAi.textContent =
      typeof health.azure_openai_configured === "boolean" ? String(health.azure_openai_configured) : "Not returned by backend";
  } catch (error) {
    els.topHealthDot.className = "health-dot fail";
    els.topHealthText.textContent = "Backend unavailable";
    els.dashboardHealthPill.textContent = "FAILED";
    els.dashboardHealthPill.className = "status-pill failed";
    els.healthStatus.textContent = "Unavailable";
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
    if (cached?.ocr_eval?.diff_result || cached?.diff_result) return cached;
  }
  const report = await api.report(name);
  report.name = name;
  state.reportCache.set(name, report);
  return report;
}

function openReportModal(report) {
  state.activeModalReport = report;
  const ocr = ocrEval(report);
  const scores = ocr.f1_scores || {};
  const combined = combinedScores(report);
  const llm = llmEval(report);

  els.modalTitle.textContent = reportName(report) || "Evaluation Report";
  els.modalSubtitle.textContent = `${report.filename || "-"} | ${report.timestamp || "-"}`;
  els.modalRunId.textContent = report.run_id || "-";
  els.modalFilename.textContent = report.filename || "-";
  els.combinedModalF1.textContent = formatScore(combined.f1);
  els.combinedModalPrecision.textContent = formatScore(combined.precision);
  els.combinedModalRecall.textContent = formatScore(combined.recall);
  els.ocrModalF1.textContent = formatScore(scores.f1);
  els.ocrModalPrecision.textContent = formatScore(scores.precision);
  els.ocrModalRecall.textContent = formatScore(scores.recall);
  renderSummaryTab(report);

  const diff = ocr.diff_result || {};
  els.ocrMissingCount.textContent = diff.total_missing ?? 0;
  els.ocrAddedCount.textContent = diff.total_added ?? 0;

  const fuzz = ocr.fuzz_result || {};
  const jiwer = ocr.jiwer_result || {};
  const rows = Object.entries(fuzz).map(([field, result]) => {
    const fieldJiwer = jiwer[field] || {};
    return `
      <tr class="${statusRowClass(result.status)}">
        <td>${escapeHtml(field)}</td>
        <td>${formatScore(fieldJiwer.cer)}</td>
        <td>${formatScore(fieldJiwer.wer)}</td>
        <td>${formatScore(result.score)}</td>
        <td>${statusPill(result.status)}</td>
      </tr>
    `;
  });
  const ocrEmptyMessage =
    report.eval_type === "llm"
      ? "OCR eval was not run for this saved LLM-only report"
      : "No OCR field results available from this report";
  els.ocrFieldResultsBody.innerHTML = rows.join("") || `<tr><td colspan="5" class="empty-row">${ocrEmptyMessage}</td></tr>`;

  if (!llm) {
    els.legacyLlmNote.hidden = false;
    els.llmModalF1.textContent = "-";
    els.llmModalPrecision.textContent = "-";
    els.llmModalRecall.textContent = "-";
    els.llmTp.textContent = "-";
    els.llmFp.textContent = "-";
    els.llmFn.textContent = "-";
    els.llmGrey.textContent = "-";
    els.llmFieldResultsBody.innerHTML = '<tr><td colspan="4" class="empty-row">LLM eval was not run for this saved OCR-only or legacy report</td></tr>';
  } else {
    const llmScores = llm.f1_scores || {};
    els.legacyLlmNote.hidden = true;
    els.llmModalF1.textContent = formatScore(llmScores.f1);
    els.llmModalPrecision.textContent = formatScore(llmScores.precision);
    els.llmModalRecall.textContent = formatScore(llmScores.recall);
    els.llmTp.textContent = llmScores.tp ?? 0;
    els.llmFp.textContent = llmScores.fp ?? 0;
    els.llmFn.textContent = llmScores.fn ?? 0;
    els.llmGrey.textContent = llmScores.grey_count ?? 0;
    els.llmFieldResultsBody.innerHTML = Object.entries(llm.field_comparison || {})
      .map(([field, result]) => `
        <tr class="${statusRowClass(result.status)}">
          <td>${escapeHtml(field)}</td>
          <td>${escapeHtml(result.golden_value)}</td>
          <td>${escapeHtml(result.extracted_value)}</td>
          <td>${statusPill(result.status)}</td>
        </tr>
      `)
      .join("") || '<tr><td colspan="4" class="empty-row">No LLM field results available from this report</td></tr>';
  }

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

function handleApiActionClick(event) {
  const button = event.target.closest("[data-action][data-report]");
  if (!button) return;
  const reportName = button.dataset.report;
  getReport(reportName)
    .then((report) => {
      state.latestReport = report;
      renderLatest(report);
      if (button.dataset.action === "view") {
        openReportModal(report);
      } else {
        downloadReport(report);
      }
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

function wireGoldenUpload() {
  els.browseGolden.addEventListener("click", (event) => {
    event.preventDefault();
    els.goldenFile.click();
  });

  els.goldenFile.addEventListener("change", () => {
    const file = els.goldenFile.files[0];
    els.goldenFileName.textContent = file ? file.name : "Drag and drop your JSONL file here";
    clearBanner(els.goldenMessage);
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    els.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropzone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    els.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropzone.classList.remove("dragover");
    });
  });
  els.dropzone.addEventListener("drop", (event) => {
    const file = event.dataTransfer.files[0];
    if (!file) return;
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    els.goldenFile.files = dataTransfer.files;
    els.goldenFileName.textContent = file.name;
  });

  els.goldenForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearBanner(els.goldenMessage);
    const file = els.goldenFile.files[0];
    if (!file) {
      setBanner(els.goldenMessage, "Select a JSONL file before uploading.", "error");
      return;
    }
    setButtonLoading(els.uploadGoldenButton, true, "Uploading...");
    els.goldenStatus.textContent = "PARTIAL";
    els.goldenStatus.className = "status-pill partial";
    try {
      let result;
      try {
        result = await api.uploadGolden(goldenUploadFormData(file));
      } catch (error) {
        const isDuplicate = error.status === 409 && error.detail?.code === "duplicate_gds_filename";
        if (!isDuplicate) throw error;
        const shouldOverwrite = window.confirm(
          `${file.name} already exists in saved golden datasets.\n\nPress OK to replace that saved file.\nPress Cancel to save this upload as a new file.`,
        );
        result = await api.uploadGolden(
          goldenUploadFormData(file),
          shouldOverwrite ? "overwrite" : "save_new",
        );
      }
      renderGoldenUploadSuccess(result);
    } catch (error) {
      els.goldenStatus.textContent = "FAILED";
      els.goldenStatus.className = "status-pill failed";
      setBanner(els.goldenMessage, error.message, "error");
    } finally {
      setButtonLoading(els.uploadGoldenButton, false);
    }
  });
}

function wireEvaluationForm() {
  els.evalForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearBanner(els.runMessage);
    els.runStatus.textContent = "PARTIAL";
    els.runStatus.className = "status-pill partial";
    setButtonLoading(els.runButton, true, "Running...");
    try {
      const report = await api.runFullEvaluation({
        ...evaluationRequestBody(),
      });
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
      setButtonLoading(els.runButton, false);
    }
  });

  els.openLatestReport.addEventListener("click", async () => {
    if (!state.currentRunReport) return;
    const name = reportName(state.currentRunReport);
    const fullReport = name ? await getReport(name).catch(() => state.currentRunReport) : state.currentRunReport;
    openReportModal(fullReport);
  });
  els.testOcrOnly.addEventListener("click", () => runDebugEvaluation("ocr"));
  els.testLlmOnly.addEventListener("click", () => runDebugEvaluation("llm"));
  els.closeDebugOutput.addEventListener("click", () => {
    els.debugOutputPanel.hidden = true;
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
  els.historyBody.addEventListener("click", handleApiActionClick);
  els.recentReportsBody.addEventListener("click", handleApiActionClick);
}

function wireModalAndHealth() {
  els.reportTabs.forEach((tab) => {
    tab.addEventListener("click", () => setReportTab(tab.dataset.reportTab));
  });
  els.downloadSummaryReport.addEventListener("click", () => {
    if (state.activeModalReport) downloadReport(state.activeModalReport);
  });
  els.viewBreakdownButton.addEventListener("click", () => setReportTab("ocr"));
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
  wireGoldenUpload();
  wireEvaluationForm();
  wireHistory();
  wireModalAndHealth();
  refreshAll();
}

init();
