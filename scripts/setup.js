const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const venvDir = path.join(root, ".venv");
const venvPython = process.platform === "win32"
  ? path.join(venvDir, "Scripts", "python.exe")
  : path.join(venvDir, "bin", "python");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    ...options,
  });
  return result.status === 0;
}

function createVenv() {
  const candidates = [];
  if (process.env.PYTHON) candidates.push([process.env.PYTHON, ["-m", "venv", ".venv"]]);
  candidates.push(["python", ["-m", "venv", ".venv"]]);
  candidates.push(["py", ["-3", "-m", "venv", ".venv"]]);
  candidates.push(["python3", ["-m", "venv", ".venv"]]);

  for (const [command, args] of candidates) {
    if (run(command, args)) return true;
  }
  return false;
}

if (!fs.existsSync(venvPython)) {
  console.log("Creating Python virtual environment in .venv...");
  if (!createVenv()) {
    console.error("Unable to create .venv. Install Python 3 and ensure python, py, or python3 is on PATH.");
    process.exit(1);
  }
} else {
  console.log("Using existing Python virtual environment.");
}

console.log("Installing Python dependencies from requirements.txt...");
if (!run(venvPython, ["-m", "pip", "install", "-r", "requirements.txt"])) {
  console.error("Dependency installation failed.");
  process.exit(1);
}

console.log("Setup complete.");
