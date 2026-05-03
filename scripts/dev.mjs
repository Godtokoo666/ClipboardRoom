import { spawn } from "node:child_process";
import { watch } from "node:fs";
import http from "node:http";
import path from "node:path";

const root = process.cwd();
const reloadPort = Number(process.env.DEV_RELOAD_PORT || 35729);

const clients = new Set();

let clientBuildTimer = null;
let serverReloadTimer = null;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: {
        ...process.env,
        NODE_ENV: "development",
        DEV_RELOAD_PORT: String(reloadPort),
      },
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

async function buildClient() {
  await run("node", ["scripts/build-client.mjs"]);
}

function notifyReload() {
  for (const response of clients) {
    response.write("data: reload\n\n");
  }
}

function startReloadServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      res.write(": connected\n\n");
      clients.add(res);

      req.on("close", () => {
        clients.delete(res);
      });

      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(reloadPort, () => {
    console.log(`[dev] live reload server: http://localhost:${reloadPort}`);
  });

  return server;
}

function watchDir(dir, onChange) {
  const fullPath = path.join(root, dir);

  return watch(fullPath, { recursive: false }, (_event, filename) => {
    if (!filename) return;
    if (filename.startsWith(".")) return;
    onChange(filename);
  });
}

function scheduleClientRebuild() {
  clearTimeout(clientBuildTimer);

  clientBuildTimer = setTimeout(async () => {
    try {
      await buildClient();
      notifyReload();
      console.log("[dev] client rebuilt");
    } catch (err) {
      console.error("[dev] client build failed");
      console.error(err);
    }
  }, 150);
}

function scheduleServerReload() {
  clearTimeout(serverReloadTimer);

  serverReloadTimer = setTimeout(() => {
    notifyReload();
    console.log("[dev] server changed, browser reloaded");
  }, 1000);
}

await buildClient();

const reloadServer = startReloadServer();

const watchers = [
  watchDir("public", scheduleClientRebuild),
  watchDir("src", scheduleServerReload),
];

const serverProcess = spawn("tsx", ["watch", "src/server.ts"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    NODE_ENV: "development",
    DEV_RELOAD_PORT: String(reloadPort),
  },
});

function shutdown() {
  for (const watcher of watchers) {
    watcher.close();
  }

  reloadServer.close();
  serverProcess.kill("SIGTERM");

  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

serverProcess.on("exit", (code) => {
  if (code !== null && code !== 0) {
    process.exit(code);
  }
});