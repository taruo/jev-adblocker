// Local-only diagnostic server. No real API calls, keys, or browser-profile access.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const log = path.join(__dirname, "observer-regression-results.jsonl");
const baseline = execFileSync("git", ["show", "31039ef:content.js"], { cwd: root, encoding: "utf8" });
http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:8765");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "POST" && url.pathname === "/result") {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 20000) req.destroy(); });
    req.on("end", () => {
      const result = JSON.parse(body);
      fs.appendFileSync(log, JSON.stringify(result) + "\n", "utf8");
      console.log(JSON.stringify(result));
      res.end("ok");
    });
    return;
  }
  if (url.pathname === "/content.js") {
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    // Serve the real file unchanged. Historical source is only the positive control.
    res.end(url.searchParams.get("baseline") === "1" ? baseline : fs.readFileSync(path.join(root, "content.js"), "utf8"));
    return;
  }
  if (url.pathname === "/content.css") {
    res.setHeader("Content-Type", "text/css; charset=utf-8");
    res.end(fs.readFileSync(path.join(root, "content.css")));
    return;
  }
  const file = { "/": "observer-repro.html", "/repro.js": "observer-repro.js" }[url.pathname];
  if (!file) { res.writeHead(404); res.end(); return; }
  res.setHeader("Content-Type", file.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8");
  res.end(fs.readFileSync(path.join(__dirname, file)));
}).listen(8765, "127.0.0.1", () => console.log("Diagnostic server http://127.0.0.1:8765 (Ctrl+C to stop)"));
