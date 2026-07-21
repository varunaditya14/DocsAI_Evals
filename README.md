# DocsAI Evals

DocsAI Evals is a FastAPI backend with a plain HTML/CSS/JS portal for evaluating DocsAI OCR markdown and LLM field extraction against a golden dataset.

The app runs from one backend server. FastAPI serves both the API and the frontend, so you only need to open:

```text
http://127.0.0.1:8000
```

## What This Project Does

- Fetches DocsAI run steps using the configured DocsAI endpoint.
- Extracts OCR markdown and LLM output from the run.
- Cleans OCR markdown without changing real document content.
- User enters expected ("golden") field values directly in the UI for each run
  (simple fields, multiline text blocks, or line-item tables) — there is no
  golden dataset file to upload.
- Scores extracted fields using RapidFuzz, with Azure OpenAI as a semantic
  judge for the uncertain 70-89% match range.
- Uses Azure OpenAI with `DefaultAzureCredential` for grey-zone field judging
  and for diagnosing failed fields as prompt problems vs. OCR limitations.
- Saves timestamped JSON reports into `RESULTS_PATH`.
- Shows dashboard, run evaluation, history, report modal, and health views in the frontend.

## Setup

Run these commands from the project root:

```bash
npm install
npm run setup
copy .env.example .env
npm run dev
```

Then open:

```text
http://127.0.0.1:8000
```

On Windows PowerShell, if `npm` is blocked by script policy, use:

```bash
npm.cmd run setup
npm.cmd run dev
```

## Environment

Fill `.env` using `.env.example` as the template:

```env
DOCSAI_BASE_URL=
DOCSAI_CLIENT_ID=
DOCSAI_AUTH_EMAIL=
DOCSAI_TOKEN_EXPIRY_MINUTES=50

AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_REGION=
AZURE_OPENAI_DEPLOYMENT=gpt-5.1
AZURE_OPENAI_API_VERSION=2025-01-01-preview
AZURE_AUTH_METHOD=default_credential

# GDS_PATH is deprecated and no longer read by the app. It is only kept so
# older .env files do not break startup. Safe to omit.
GDS_PATH=data/golden_dataset.jsonl
RESULTS_PATH=results
```

Do not commit `.env`. It contains local credentials and environment-specific values.

## Azure OpenAI Authentication

This project uses Azure CLI login and `DefaultAzureCredential` for grey-zone LLM judging. No OpenAI API key is required or stored.

Check Azure CLI and sign in:

```bash
az --version
az login
az account show
```

If browser sign-in is not convenient, use device code login:

```bash
az login --use-device-code
```

Developers must have access to the Azure OpenAI resource and deployment through their company Azure account.

## Commands

```bash
npm run setup
```

Creates `.venv` if needed and installs Python dependencies from `requirements.txt`.

```bash
npm run dev
```

Starts FastAPI with reload at `http://127.0.0.1:8000`.

```bash
npm run start
```

Starts FastAPI without reload.

```bash
npm run clean
```

Removes Python cache files.

## Golden Fields (current flow)

There is no golden dataset file anymore. For each run, enter the DocsAI
`run_id` in the Run Evaluation page, click "Load run fields" to see what
DocsAI extracted, then add the expected ("golden") values yourself:

- **Simple field** — a single expected value (e.g. `invoiceNo`, `date`).
- **Text block** — a multiline expected value (e.g. `billTo`, `deliveryTo`).
- **Line items table** — expected rows/columns for tabular data (e.g. `lineItems`).

Field names must be lower camelCase (e.g. `invoiceNo`, `dateOfBirth`). These
values are sent directly in the `POST /api/evaluations/run` request body and
are never persisted to a file — only the resulting evaluation report is
saved (see Results below). The browser's `sessionStorage` remembers your
last-entered values per run ID so you can restore them if you reload the page.

`backend/golden_loader.py` implements the old file-based golden dataset
loader and `GDS_PATH` config value. Both are deprecated, unused by the API,
and kept only for reference.

## Results

`RESULTS_PATH` points to the local report output folder. The default is:

```text
results
```

Each evaluation saves a timestamped JSON report so old reports are not overwritten. Generated reports are ignored by Git. Keep only `results/.gitkeep` in the repository.

## Backend Testing Order

Use Swagger at `http://127.0.0.1:8000/docs` or call endpoints directly in this order:

1. `GET /api/health`
2. `GET /api/debug/docsai/auth`
3. `GET /api/debug/docsai/run/{run_id}`
4. `GET /api/run/{run_id}/fields`
5. `POST /api/evaluations/run`
6. `GET /api/evaluations/reports`
7. `GET /api/evaluations/summary`

There is no `/api/golden/upload` or `/api/debug/golden` endpoint — those
belonged to an older golden-dataset-file architecture and have been removed
from the API. Golden values are entered directly in the Run Evaluation UI.

## Frontend

The frontend is plain HTML/CSS/JS in `frontend/`.

FastAPI serves:

- `/` -> `frontend/index.html`
- `/assets/...` -> frontend CSS and JavaScript
- `/api/...` -> backend API routes

No separate frontend server is required.

## GitHub Checklist

Before pushing, make sure these are not committed:

- `.env`
- `.venv/`
- `node_modules/`
- `data/golden_dataset.jsonl`
- generated files in `results/`
- Python cache files such as `__pycache__/` and `.pyc`

These are intentionally ignored by `.gitignore`.
