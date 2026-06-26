const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function cleanDirectory(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__pycache__") {
        fs.rmSync(fullPath, { recursive: true, force: true });
        console.log(`Removed ${path.relative(root, fullPath)}`);
      } else if (entry.name !== ".venv" && entry.name !== ".git") {
        cleanDirectory(fullPath);
      }
    } else if (entry.isFile() && entry.name.endsWith(".pyc")) {
      fs.rmSync(fullPath, { force: true });
      console.log(`Removed ${path.relative(root, fullPath)}`);
    }
  }
}

cleanDirectory(root);
console.log("Python cache cleanup complete.");
