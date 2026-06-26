const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const venvPython = process.platform === "win32"
  ? path.join(root, ".venv", "Scripts", "python.exe")
  : path.join(root, ".venv", "bin", "python");

if (!fs.existsSync(venvPython)) {
  console.error("Python virtual environment not found. Run npm run setup first.");
  process.exit(1);
}

const args = [
  "-m",
  "uvicorn",
  "backend.main:app",
  "--host",
  "127.0.0.1",
  "--port",
  "8000",
];

if (process.argv.includes("--reload")) {
  args.push("--reload");
}

const child = spawn(venvPython, args, {
  cwd: root,
  stdio: "inherit",
  shell: false,
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
