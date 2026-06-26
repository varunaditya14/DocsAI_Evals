const state = {
  reports: [],
  reportCache: new Map(),
  f1SortDirection: "desc",
  latestReport: null,
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
  resultSubtitle: $("#resultSubtitle"),
  resultStatus: $("#resultStatus"),
  resultRunId: $("#resultRunId"),
  resultFilename: $("#resultFilename"),
  resultPrecision: $("#resultPrecision"),
  resultRecall: $("#resultRecall"),
  resultF1: $("#resultF1"),
  openLatestReport: $("#openLatestReport"),
  historySearch: $("#historySearch"),
  refreshReports: $("#refreshReports"),
  historyMessage: $("#historyMessage"),
  reportCount: $("#reportCount"),
  sortF1: $("#sortF1"),
  sortF1Indicator: $("#sortF1Indicator"),
  historyBody: $("#historyBody"),
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
  modalPrecision: $("#modalPrecision"),
  modalRecall: $("#modalRecall"),
  modalF1: $("#modalF1"),
  modalUnresolved: $("#modalUnresolved"),
  missingLines: $("#missingLines"),
  addedLines: $("#addedLines"),
  fieldResultsBody: $("#fieldResultsBody"),
};

const api = {
  async request(path, options = {}) {
    const response = await fetch(path, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.detail || `Request failed with HTTP ${response.status}`);
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
  uploadGolden(formData) {
    return this.request("/api/golden/upload", { method: "POST", body: formData });
  },
  runEvaluation(body) {
    return this.request("/api/evaluations/run", {
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
  if (normalized === "UNRESOLVED") return "unresolved";
  return "partial";
}

function statusLabel(status) {
  const normalized = String(status || "").toUpperCase();
  if (normalized === "TP") return "PASS";
  if (normalized === "FP") return "FAIL";
  if (normalized === "FN") return "MISSING";
  return normalized || "PARTIAL";
}

function statusPill(status) {
  return `<span class="status-pill ${statusClass(status)}">${escapeHtml(statusLabel(status))}</span>`;
}

function overallStatus(report) {
  const scores = report.f1_scores || {};
  if (scores.unresolved_count > 0) return "PARTIAL";
  if (typeof scores.f1 === "number" && scores.f1 >= 0.9) return "COMPLETED";
  if (typeof scores.f1 === "number" && scores.f1 > 0) return "PARTIAL";
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
      const af1 = typeof a.f1_scores?.f1 === "number" ? a.f1_scores.f1 : -1;
      const bf1 = typeof b.f1_scores?.f1 === "number" ? b.f1_scores.f1 : -1;
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
      const scores = report.f1_scores || {};
      return `
        <tr>
          <td>${escapeHtml(report.name)}</td>
          <td>${escapeHtml(report.run_id || "-")}</td>
          <td>${escapeHtml(report.filename || "-")}</td>
          <td>${formatScore(scores.f1)}</td>
          <td>${statusPill(overallStatus(report))}</td>
          <td>${reportActionButtons(report.name)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderHistory() {
  const reports = filteredReports();
  els.reportCount.textContent = `${reports.length} report${reports.length === 1 ? "" : "s"}`;
  els.sortF1Indicator.textContent = state.f1SortDirection === "asc" ? "up" : "down";

  if (!reports.length) {
    els.historyBody.innerHTML = '<tr><td colspan="9" class="empty-row">No reports found</td></tr>';
    return;
  }

  els.historyBody.innerHTML = reports
    .map((report) => {
      const scores = report.f1_scores || {};
      return `
        <tr>
          <td>${escapeHtml(report.name)}</td>
          <td>${escapeHtml(report.run_id || "-")}</td>
          <td>${escapeHtml(report.filename || "-")}</td>
          <td>${formatScore(scores.f1)}</td>
          <td>${formatScore(scores.recall)}</td>
          <td>${formatScore(scores.precision)}</td>
          <td>${escapeHtml(report.timestamp || "-")}</td>
          <td>${statusPill(overallStatus(report))}</td>
          <td>${reportActionButtons(report.name)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderSummary(summary) {
  els.totalRuns.textContent = summary.total_runs ?? 0;
  els.averageF1.textContent = formatScore(summary.average_f1);
  els.averageRecall.textContent = formatScore(summary.average_recall);
  els.worstField.textContent = summary.worst_field || "-";
}

function renderLatest(report) {
  if (!report) {
    els.latestReportLabel.textContent = "No report selected";
    els.latestPrecision.textContent = "-";
    els.latestRecall.textContent = "-";
    els.latestF1.textContent = "-";
    els.latestMissing.textContent = "-";
    return;
  }
  const scores = report.f1_scores || {};
  els.latestReportLabel.textContent = report.filename || report.name;
  els.latestPrecision.textContent = formatScore(scores.precision);
  els.latestRecall.textContent = formatScore(scores.recall);
  els.latestF1.textContent = formatScore(scores.f1);
  els.latestMissing.textContent = report.diff_result?.total_missing ?? "-";
}

function renderRunResult(report) {
  const scores = report.f1_scores || {};
  els.resultSubtitle.textContent = report.report_filename || "Evaluation completed";
  els.resultStatus.textContent = statusLabel(overallStatus(report));
  els.resultStatus.className = `status-pill ${statusClass(overallStatus(report))}`;
  els.resultRunId.textContent = report.run_id || "-";
  els.resultFilename.textContent = report.filename || "-";
  els.resultPrecision.textContent = formatScore(scores.precision);
  els.resultRecall.textContent = formatScore(scores.recall);
  els.resultF1.textContent = formatScore(scores.f1);
  els.openLatestReport.disabled = false;
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
    state.reports = payload.reports || [];
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
  if (state.reportCache.has(name)) return state.reportCache.get(name);
  const report = await api.report(name);
  report.name = name;
  state.reportCache.set(name, report);
  return report;
}

function openReportModal(report) {
  const scores = report.f1_scores || {};
  els.modalTitle.textContent = report.name || report.report_filename || "Evaluation Report";
  els.modalSubtitle.textContent = `${report.filename || "-"} | ${report.timestamp || "-"}`;
  els.modalRunId.textContent = report.run_id || "-";
  els.modalFilename.textContent = report.filename || "-";
  els.modalPrecision.textContent = formatScore(scores.precision);
  els.modalRecall.textContent = formatScore(scores.recall);
  els.modalF1.textContent = formatScore(scores.f1);
  els.modalUnresolved.textContent = scores.unresolved_count ?? 0;

  const diff = report.diff_result || {};
  els.missingLines.textContent = (diff.missing_lines || []).join("\n") || "No missing lines";
  els.addedLines.textContent = (diff.added_lines || []).join("\n") || "No added lines";

  const fuzz = report.fuzz_result || {};
  const jiwer = report.jiwer_result || {};
  const rows = Object.entries(fuzz).map(([field, result]) => {
    const fieldJiwer = jiwer[field] || {};
    const metricParts = [];
    if (typeof result.score === "number") metricParts.push(`Similarity ${formatScore(result.score)}`);
    if (typeof fieldJiwer.cer === "number") metricParts.push(`CER ${formatScore(fieldJiwer.cer)}`);
    if (typeof fieldJiwer.wer === "number") metricParts.push(`WER ${formatScore(fieldJiwer.wer)}`);
    return `
      <tr>
        <td>${escapeHtml(field)}</td>
        <td>${statusPill(result.status)}${result.llm_judged ? ' <span class="status-pill ready">LLM</span>' : ""}</td>
        <td>${escapeHtml(result.golden)}</td>
        <td>${escapeHtml(result.extracted)}</td>
        <td>${escapeHtml(metricParts.join(" / ") || "-")}</td>
      </tr>
    `;
  });
  els.fieldResultsBody.innerHTML = rows.join("") || '<tr><td colspan="5" class="empty-row">No field results</td></tr>';
  els.reportModal.hidden = false;
}

function downloadReport(report) {
  const fileName = report.name || report.report_filename || "docsai_eval_report.json";
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
    const formData = new FormData();
    formData.append("file", file);
    setButtonLoading(els.uploadGoldenButton, true, "Uploading...");
    els.goldenStatus.textContent = "PARTIAL";
    els.goldenStatus.className = "status-pill partial";
    try {
      const result = await api.uploadGolden(formData);
      els.currentGdsFile.textContent = `${result.filename} (${result.records} records)`;
      els.goldenStatus.textContent = "COMPLETED";
      els.goldenStatus.className = "status-pill completed";
      setBanner(els.goldenMessage, `Uploaded ${result.records} valid records.`, "success");
      showToast("Golden dataset uploaded");
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
      const report = await api.runEvaluation({
        run_id: els.runId.value.trim(),
        filename: els.filename.value.trim(),
      });
      state.latestReport = report;
      state.reportCache.set(report.report_filename || report.name, report);
      renderRunResult(report);
      renderLatest(report);
      els.runStatus.textContent = "COMPLETED";
      els.runStatus.className = "status-pill completed";
      setBanner(els.runMessage, "Evaluation completed successfully.", "success");
      await Promise.all([loadSummary(), loadReports()]);
    } catch (error) {
      els.runStatus.textContent = "FAILED";
      els.runStatus.className = "status-pill failed";
      setBanner(els.runMessage, error.message, "error");
    } finally {
      setButtonLoading(els.runButton, false);
    }
  });

  els.openLatestReport.addEventListener("click", () => {
    if (state.latestReport) openReportModal(state.latestReport);
  });
}

function wireHistory() {
  els.historySearch.addEventListener("input", renderHistory);
  els.sortF1.addEventListener("click", () => {
    state.f1SortDirection = state.f1SortDirection === "asc" ? "desc" : "asc";
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
