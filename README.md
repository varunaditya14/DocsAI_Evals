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
- Loads a golden dataset from `GDS_PATH`.
- Compares OCR markdown with golden markdown using `difflib`.
- Scores extracted fields using CER/WER and RapidFuzz.
- Uses Azure OpenAI with `DefaultAzureCredential` for grey-zone field judging.
- Saves timestamped JSON reports into `RESULTS_PATH`.
- Shows dashboard, upload, run evaluation, history, report modal, and health views in the frontend.

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

## Golden Dataset

`GDS_PATH` points to the local normalized golden dataset file. The default is:

```text
data/golden_dataset.jsonl
```

The upload endpoint accepts:

- `.jsonl`, preferred, with one JSON object per non-empty line.
- `.json`, as either a single object or an array of objects.

Uploaded `.json` files are validated and normalized to JSONL before saving to `GDS_PATH`.

Each record must include a non-empty `filename` and either reference markdown or a supported document object such as `taxInvoice`, `tax_invoice`, `purchaseOrder`, `purchase_order`, `proformaInvoice`, or `proforma_invoice`.

Generated golden data is ignored by Git. Keep only `data/.gitkeep` in the repository.

## Results

`RESULTS_PATH` points to the local report output folder. The default is:

```text
results
```

Each evaluation saves a timestamped JSON report so old reports are not overwritten. Generated reports are ignored by Git. Keep only `results/.gitkeep` in the repository.

## Backend Testing Order

Use Swagger at `http://127.0.0.1:8000/docs` or call endpoints directly in this order:

1. `GET /api/health`
2. `POST /api/golden/upload`
3. `GET /api/debug/golden`
4. `GET /api/debug/docsai/auth`
5. `GET /api/debug/docsai/run/{run_id}`
6. `POST /api/evaluations/run`
7. `GET /api/evaluations/reports`
8. `GET /api/evaluations/summary`

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
