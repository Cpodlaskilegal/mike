import { createAuth } from "./auth.mjs";
import { clearCache } from "./cache.mjs";
import { loadConfig } from "./config.mjs";
import { pathSegment, requestJson } from "./http.mjs";
import { ask } from "./stream.mjs";

export const USAGE = `Docket CLI

Usage: docket <command> [arguments] [--json]

  login                         Sign in using a Microsoft device code
  logout                        Remove the local CLI token cache
  health                        Check the Docket API
  whoami                        Show the signed-in account and Docket profile
  projects list                 List accessible projects
  projects show <id>            Show a project and its documents
  chats list                    List recent accessible chats
  chats show <id>               Show a chat and its messages
  project-chats list <id>       List chats within a project
  documents list [--project <id>]
                                List standalone or project documents
  workflows list [--type assistant|tabular]
                                List accessible workflows
  ask <prompt> [--project <id>] [--chat <id>]
                                Ask Docket and wait for a completed response

Options: --json outputs machine-readable JSON on stdout.
Environment: DOCKET_API_BASE_URL, DOCKET_TENANT_ID, DOCKET_CLIENT_ID,
             DOCKET_API_SCOPE, DOCKET_CACHE_PATH.
`;

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  if (args.indexOf(name, index + 1) >= 0) throw new Error(`${name} can only be specified once`);
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function expect(args, expected) {
  if (args.length !== expected.length || args.some((arg, i) => arg !== expected[i])) {
    throw new Error(`Invalid arguments. Run docket help for usage.`);
  }
}

export function parseArgs(argv) {
  const json = argv.includes("--json");
  const args = argv.filter((arg) => arg !== "--json");
  if (args.length === 0 || args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    return { action: "help", json };
  }
  const command = args.shift();
  if (["login", "logout", "health", "whoami"].includes(command)) {
    expect(args, []);
    return { action: command, json };
  }
  if (command === "projects" || command === "chats") {
    if (args[0] === "list") {
      expect(args, ["list"]);
      return { action: `${command}.list`, json };
    }
    if (args[0] === "show" && args.length === 2 && !args[1].startsWith("--")) {
      return { action: `${command}.show`, id: args[1], json };
    }
  }
  if (command === "project-chats" && args[0] === "list" && args.length === 2 && !args[1].startsWith("--")) {
    return { action: "project-chats.list", id: args[1], json };
  }
  if (command === "documents") {
    const projectId = optionValue(args, "--project");
    expect(args, ["list"]);
    return { action: "documents.list", projectId, json };
  }
  if (command === "workflows") {
    const type = optionValue(args, "--type");
    expect(args, ["list"]);
    if (type && !["assistant", "tabular"].includes(type)) {
      throw new Error("--type must be assistant or tabular");
    }
    return { action: "workflows.list", type, json };
  }
  if (command === "ask") {
    const projectId = optionValue(args, "--project");
    const chatId = optionValue(args, "--chat");
    if (args[0] === "--") args.shift();
    if (!args.length || args.some((arg) => arg.startsWith("--"))) {
      throw new Error("ask requires a prompt; quote prompts containing option-like text");
    }
    const prompt = args.join(" ").trim();
    if (!prompt) throw new Error("ask requires a non-empty prompt");
    return { action: "ask", prompt, projectId, chatId, json };
  }
  throw new Error("Unknown command or arguments. Run docket help for usage.");
}

function rows(data, columns) {
  if (!Array.isArray(data) || !data.length) return "(none)";
  const cells = data.map((row) => columns.map(([key]) => String(row?.[key] ?? "")));
  const widths = columns.map(([, title], i) => Math.max(title.length, ...cells.map((row) => row[i].length)));
  const line = (values) => values.map((value, i) => value.padEnd(widths[i])).join("  ").trimEnd();
  return [line(columns.map(([, title]) => title)), ...cells.map(line)].join("\n");
}

function humanOutput(action, data) {
  switch (action) {
    case "login":
      return `Signed in as ${data.username}`;
    case "logout":
      return "Signed out of the Docket CLI";
    case "health":
      return data?.ok ? "Docket API: OK" : JSON.stringify(data, null, 2);
    case "whoami":
      return [
        `Account: ${data.account.username}`,
        `Name: ${data.profile.displayName || data.account.name || ""}`,
        `Role: ${data.profile.role || ""}`,
      ].join("\n");
    case "projects.list":
      return rows(data, [["id", "ID"], ["name", "NAME"], ["document_count", "DOCS"], ["chat_count", "CHATS"]]);
    case "chats.list":
    case "project-chats.list":
      return rows(data, [["id", "ID"], ["title", "TITLE"], ["created_at", "CREATED"]]);
    case "documents.list":
      return rows(data, [["id", "ID"], ["filename", "FILENAME"], ["file_type", "TYPE"]]);
    case "workflows.list":
      return rows(data, [["id", "ID"], ["title", "TITLE"], ["type", "TYPE"]]);
    case "ask":
      return data.text || "(No text response)";
    default:
      return JSON.stringify(data, null, 2);
  }
}

export async function runCli(argv, {
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  fetchImpl = fetch,
  authFactory = createAuth,
} = {}) {
  const input = parseArgs(argv);
  if (input.action === "help") {
    stdout.write(USAGE);
    return;
  }
  const config = loadConfig(env);
  if (input.action === "logout") {
    await clearCache(config.cachePath);
    const result = { signedOut: true };
    stdout.write(`${input.json ? JSON.stringify(result) : humanOutput(input.action, result)}\n`);
    return;
  }
  const auth = ["health"].includes(input.action) ? null : await authFactory(config, { stderr });
  let result;
  switch (input.action) {
    case "login":
      result = await auth.login();
      break;
    case "health":
      result = await requestJson(config, "/health", { fetchImpl });
      break;
    case "whoami": {
      const [account, profile] = await Promise.all([
        auth.account(),
        requestJson(config, "/user/profile", { auth, fetchImpl }),
      ]);
      result = { account, profile };
      break;
    }
    case "projects.list":
      result = await requestJson(config, "/projects", { auth, fetchImpl });
      break;
    case "projects.show":
      result = await requestJson(config, `/projects/${pathSegment(input.id)}`, { auth, fetchImpl });
      break;
    case "chats.list":
      result = await requestJson(config, "/chat", { auth, fetchImpl });
      break;
    case "chats.show":
      result = await requestJson(config, `/chat/${pathSegment(input.id)}`, { auth, fetchImpl });
      break;
    case "project-chats.list":
      result = await requestJson(config, `/projects/${pathSegment(input.id)}/chats`, { auth, fetchImpl });
      break;
    case "documents.list":
      result = await requestJson(config, input.projectId
        ? `/projects/${pathSegment(input.projectId)}/documents` : "/single-documents", { auth, fetchImpl });
      break;
    case "workflows.list":
      result = await requestJson(config, input.type
        ? `/workflows?type=${encodeURIComponent(input.type)}` : "/workflows", { auth, fetchImpl });
      break;
    case "ask":
      result = await ask(config, auth, input, fetchImpl);
      break;
    default:
      throw new Error("Unsupported command");
  }
  stdout.write(`${input.json ? JSON.stringify(result) : humanOutput(input.action, result)}\n`);
  if (input.action === "ask" && !input.json && result.chatId) {
    stderr.write(`Chat ID: ${result.chatId}\n`);
  }
}
