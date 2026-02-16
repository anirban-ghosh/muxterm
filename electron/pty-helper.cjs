#!/usr/bin/env node

const pty = require("node-pty");

const sessions = new Map();
let inputBuffer = "";

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function onCreate(msg) {
  const { sessionId, command, args, options } = msg;
  try {
    const instance = pty.spawn(command, args || [], {
      cols: (options && options.cols) || 120,
      rows: (options && options.rows) || 35,
      cwd: (options && options.cwd) || process.cwd(),
      env: process.env,
      name: process.platform === "win32" ? "xterm-256color" : "xterm-color"
    });

    sessions.set(sessionId, instance);
    send({ type: "created", sessionId, pid: instance.pid });

    instance.onData((data) => {
      send({ type: "data", sessionId, data });
    });

    instance.onExit(({ exitCode }) => {
      sessions.delete(sessionId);
      send({ type: "exit", sessionId, exitCode });
    });
  } catch (error) {
    send({
      type: "create-error",
      sessionId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

function onWrite(msg) {
  const instance = sessions.get(msg.sessionId);
  if (!instance) {
    return;
  }
  try {
    instance.write(msg.data || "");
  } catch (_error) {
    // Ignore write errors for closed sessions.
  }
}

function onResize(msg) {
  const instance = sessions.get(msg.sessionId);
  if (!instance) {
    return;
  }
  try {
    const cols = Math.max(10, Math.floor(msg.cols || 80));
    const rows = Math.max(5, Math.floor(msg.rows || 24));
    instance.resize(cols, rows);
  } catch (_error) {
    // Ignore resize errors.
  }
}

function onKill(msg) {
  const instance = sessions.get(msg.sessionId);
  if (!instance) {
    return;
  }
  try {
    instance.kill();
  } catch (_error) {
    // Ignore kill errors.
  }
  sessions.delete(msg.sessionId);
}

function handleMessage(msg) {
  if (!msg || typeof msg.type !== "string") {
    return;
  }

  if (msg.type === "create") {
    onCreate(msg);
  } else if (msg.type === "write") {
    onWrite(msg);
  } else if (msg.type === "resize") {
    onResize(msg);
  } else if (msg.type === "kill") {
    onKill(msg);
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
  const lines = inputBuffer.split("\n");
  inputBuffer = lines.pop() || "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      handleMessage(JSON.parse(trimmed));
    } catch (_error) {
      // Ignore malformed lines.
    }
  }
});

process.stdin.on("end", () => {
  for (const instance of sessions.values()) {
    try {
      instance.kill();
    } catch (_error) {
      // Ignore.
    }
  }
  sessions.clear();
  process.exit(0);
});
