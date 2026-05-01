import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONTROL_COMMAND_RE = /^\/(?:reset|new)\b/i;
const ENV_PATH = new URL(".env", import.meta.url);
const ENV_FILE = fileURLToPath(ENV_PATH);
const ENV_CONFIG = loadExtensionEnv();
const EXTENSION_SETTINGS = resolveExtensionSettings(ENV_CONFIG);
const FALLBACK_MONITORED_GROUPS = EXTENSION_SETTINGS.monitoredGroups;
const TARGET_NUMBERS = EXTENSION_SETTINGS.targetNumbers;
const TARGET_DIGITS = EXTENSION_SETTINGS.targetDigits;
const BOT_MENTION_IDS = EXTENSION_SETTINGS.botMentionIds;
const BOT_NAME_RE = EXTENSION_SETTINGS.botNameRe;
const FALLBACK_WORKSPACE_DIR = EXTENSION_SETTINGS.workspaceDir;
const recentInboundMessages = [];

function loadExtensionEnv() {
  if (!existsSync(ENV_FILE)) return { __missingFile: true };

  const values = {};
  const contents = readFileSync(ENV_FILE, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const normalizedLine = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equalsIndex = normalizedLine.indexOf("=");
    if (equalsIndex <= 0) continue;

    const key = normalizedLine.slice(0, equalsIndex).trim();
    let value = normalizedLine.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

function readEnvList(value) {
  if (typeof value !== "string" || !value.trim()) return [];

  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return uniqueStrings(parsed.map((entry) => String(entry).trim()));
    } catch {
      // Fall back to comma-separated parsing below.
    }
  }

  return uniqueStrings(trimmed.split(",").map((entry) => entry.trim()));
}

function readEnvRegex(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;

  const trimmed = value.trim();
  const literalMatch = trimmed.match(/^\/([\s\S]*)\/([dgimsuvy]*)$/);
  if (literalMatch) {
    try {
      return new RegExp(literalMatch[1], literalMatch[2]);
    } catch {
      return undefined;
    }
  }

  try {
    return new RegExp(trimmed, "i");
  } catch {
    return undefined;
  }
}

function readRequiredEnvList(envConfig, key, issues, validate, validationMessage) {
  const entries = readEnvList(envConfig[key]);
  if (entries.length === 0) {
    issues.push(`${key} is missing or empty`);
    return [];
  }

  if (typeof validate === "function") {
    const invalidEntries = entries.filter((entry) => !validate(entry));
    if (invalidEntries.length > 0) {
      issues.push(`${key} has invalid entries (${validationMessage}): ${invalidEntries.join(", ")}`);
    }
  }

  return entries;
}

function readRequiredEnvString(envConfig, key, issues) {
  const value = typeof envConfig[key] === "string" ? envConfig[key].trim() : "";
  if (!value) {
    issues.push(`${key} is missing or empty`);
    return "";
  }
  return value;
}

function readRequiredEnvRegex(envConfig, key, issues) {
  const rawValue = typeof envConfig[key] === "string" ? envConfig[key].trim() : "";
  if (!rawValue) {
    issues.push(`${key} is missing or empty`);
    return undefined;
  }

  const regex = readEnvRegex(rawValue);
  if (!regex) issues.push(`${key} is not a valid regex`);
  return regex;
}

function resolveExtensionSettings(envConfig) {
  const issues = [];
  if (envConfig.__missingFile) issues.push(`missing settings file: ${ENV_FILE}`);

  const monitoredGroups = readRequiredEnvList(
    envConfig,
    "FALLBACK_MONITORED_GROUPS",
    issues,
    (value) => value.endsWith("@g.us"),
    "each entry must end with @g.us"
  );
  const targetNumbers = readRequiredEnvList(
    envConfig,
    "TARGET_NUMBER",
    issues,
    (value) => toDigits(value).length > 0,
    "each entry must contain at least one digit"
  );
  const configuredTargetDigits = readRequiredEnvList(
    envConfig,
    "TARGET_DIGITS",
    issues,
    (value) => toDigits(value).length > 0,
    "each entry must contain at least one digit"
  );
  const targetDigits = uniqueStrings([
    ...configuredTargetDigits.map(toDigits),
    ...targetNumbers.map(toDigits)
  ]);
  const botMentionIds = readRequiredEnvList(
    envConfig,
    "BOT_MENTION_ID",
    issues,
    (value) => String(value).trim().length > 0,
    "each entry must be non-empty"
  );
  const botNameRe = readRequiredEnvRegex(envConfig, "BOT_NAME_RE", issues);
  const workspaceDir = readRequiredEnvString(envConfig, "FALLBACK_WORKSPACE_DIR", issues);

  return {
    enabled: issues.length === 0,
    issues,
    monitoredGroups,
    targetNumbers,
    targetDigits,
    botMentionIds,
    botNameRe,
    workspaceDir
  };
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function toDigits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function containsAny(text, values) {
  return values.some((value) => text.includes(value));
}

function extractJsonBlocks(text) {
  const blocks = [];
  const pattern = /```json\s*([\s\S]*?)```/g;
  for (const match of text.matchAll(pattern)) {
    try {
      blocks.push(JSON.parse(match[1]));
    } catch {
      // Ignore malformed metadata blocks; the gate falls back to the session key.
    }
  }
  return blocks;
}

function stripJsonBlocks(text) {
  return text.replace(/```json\s*[\s\S]*?```/g, "").trim();
}

function extractMessageBody(text) {
  const blocks = [...text.matchAll(/```json\s*[\s\S]*?```/g)];
  if (blocks.length === 0) return text.trim();
  const lastBlock = blocks[blocks.length - 1];
  return text.slice((lastBlock.index ?? 0) + lastBlock[0].length).trim();
}

function extractUserAuthoredText(text) {
  const body = extractMessageBody(text ?? "") || stripJsonBlocks(text ?? "");
  if (!body) return "";

  const userTextIndex = body.lastIndexOf("User text:");
  if (userTextIndex < 0) return body.trim();

  const afterUserText = body.slice(userTextIndex + "User text:".length).trim();
  const lines = afterUserText.split(/\n/);
  const authored = [];
  for (const line of lines) {
    if (line.trim() === "Description:") break;
    const whatsappPrefix = line.match(/^\[WhatsApp[^\]]+\]\s+[^:]+:\s*(.*)$/);
    authored.push(whatsappPrefix ? whatsappPrefix[1] : line);
  }

  return authored.join("\n").trim() || body.trim();
}

function resolveMonitoredGroups(config) {
  const groups = new Set(FALLBACK_MONITORED_GROUPS);
  const configured = config?.channels?.whatsapp?.groups;
  if (configured && typeof configured === "object") {
    for (const [groupId, policy] of Object.entries(configured)) {
      if (groupId === "*" || !groupId.endsWith("@g.us")) continue;
      if (policy && typeof policy === "object" && policy.requireMention === false) {
        groups.add(groupId);
      }
    }
  }
  return groups;
}

function sessionKeyGroupId(sessionKey) {
  const match = String(sessionKey ?? "").match(/whatsapp:group:([^:]+@g\.us)$/);
  return match?.[1];
}

function metadataGroupId(block) {
  if (!block || typeof block !== "object") return undefined;
  const chatId = typeof block.chat_id === "string" ? block.chat_id : undefined;
  const label = typeof block.conversation_label === "string" ? block.conversation_label : undefined;
  const from = typeof block.from === "string" ? block.from : undefined;
  return [chatId, label, from].find((value) => value?.endsWith("@g.us"));
}

function messageExplicitlyAllowed(text, metadataBlocks) {
  const messageText = extractUserAuthoredText(text);
  if (containsAny(messageText, TARGET_NUMBERS) || containsAny(messageText, TARGET_DIGITS)) return true;
  if (BOT_MENTION_IDS.some((mentionId) => messageText.includes(`@${mentionId}`) || messageText.includes(mentionId))) return true;
  if (BOT_NAME_RE?.test(messageText)) return true;
  return metadataBlocks.some((block) => block?.was_mentioned === true || block?.wasMentioned === true);
}

function conversationMetadata(metadataBlocks) {
  return metadataBlocks.find((block) => metadataGroupId(block)) ?? {};
}

function senderMetadata(metadataBlocks) {
  return metadataBlocks.find((block) => typeof block?.id === "string" && (typeof block?.label === "string" || typeof block?.e164 === "string")) ?? {};
}

function parseConversationTimestamp(value) {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^[A-Za-z]{3}\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})\s+GMT([+-])(\d{1,2})$/);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, sign, offsetHour] = match;
  const offsetMinutes = (sign === "+" ? 1 : -1) * Number(offsetHour) * 60;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)) - offsetMinutes * 60_000);
}

function formatWibParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`
  };
}

function stateDirFromWorkspace(ctx) {
  const workspaceDir = ctx.workspaceDir || FALLBACK_WORKSPACE_DIR;
  return dirname(workspaceDir);
}

function resolveSessionFile(ctx) {
  if (!ctx.sessionId) return undefined;
  const agentId = ctx.agentId || "main";
  return join(stateDirFromWorkspace(ctx), "agents", agentId, "sessions", `${ctx.sessionId}.jsonl`);
}

function lastSessionEntryId(sessionFile) {
  if (!existsSync(sessionFile)) return undefined;
  const lines = readFileSync(sessionFile, "utf8").trim().split(/\n/).reverse();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry?.id === "string" && entry.id) return entry.id;
    } catch {
      // Ignore malformed historical lines; appending should not fail because of them.
    }
  }
  return undefined;
}

function sessionAlreadyHasMessage(sessionFile, messageId) {
  if (!messageId || !existsSync(sessionFile)) return false;
  const contents = readFileSync(sessionFile, "utf8");
  return contents.includes(`"message_id": "${messageId}"`)
    || contents.includes(`"message_id":"${messageId}"`)
    || contents.includes(`"whatsapp_message_id":"${messageId}"`)
    || contents.includes(`"provider_message_id: ${messageId}`);
}

function buildSuppressedSessionText(record) {
  const sender = record.sender_name && record.sender_id
    ? `${record.sender_name} (${record.sender_id})`
    : record.sender_name || record.sender_id || "unknown";
  return [
    "[Silent WhatsApp group message captured for future context; no visible reply was sent]",
    `time_wib: ${record.local_date} ${record.time}`,
    `group_id: ${record.group_id}`,
    `sender: ${sender}`,
    record.message_id ? `provider_message_id: ${record.message_id}` : undefined,
    "body:",
    record.body
  ].filter(Boolean).join("\n");
}

function appendSuppressedSessionTranscript(api, ctx, event, record) {
  const sessionFile = resolveSessionFile(ctx);
  if (!sessionFile) return;
  try {
    mkdirSync(dirname(sessionFile), { recursive: true });
    if (sessionAlreadyHasMessage(sessionFile, record.message_id)) return;
    const timestamp = record.timestamp || new Date().toISOString();
    const messageTimestamp = new Date(timestamp).getTime() || Date.now();
    const text = String(event.cleanedBody || record.body || "").trim();
    if (!text) return;
    if (CONTROL_COMMAND_RE.test(record.body.trim())) return;
    const sessionText = buildSuppressedSessionText(record);
    const entry = {
      type: "message",
      id: randomBytes(4).toString("hex"),
      parentId: lastSessionEntryId(sessionFile),
      timestamp,
      message: {
        role: "user",
        content: [{ type: "text", text: sessionText }],
        timestamp: messageTimestamp,
        metadata: {
          source: "wa-monitor-gate",
          schema: record.schema,
          group_id: record.group_id,
          session_key: record.session_key,
          session_id: record.session_id,
          whatsapp_message_id: record.message_id,
          sender_id: record.sender_id,
          sender_name: record.sender_name,
          suppressed: true,
          reason: record.reason
        }
      }
    };
    appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    api.logger.warn?.(`wa-monitor-gate failed to write suppressed session transcript: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function eventGroupId(event, ctx) {
  const metadataGroupIdValue = typeof event?.metadata?.originatingTo === "string" && event.metadata.originatingTo.endsWith("@g.us")
    ? event.metadata.originatingTo
    : typeof event?.metadata?.groupId === "string" && event.metadata.groupId.endsWith("@g.us")
      ? event.metadata.groupId
      : undefined;
  const fromGroup = typeof event?.from === "string" && event.from.endsWith("@g.us") ? event.from : undefined;
  const conversationGroup = typeof ctx?.conversationId === "string" && ctx.conversationId.endsWith("@g.us") ? ctx.conversationId : undefined;
  return metadataGroupIdValue || fromGroup || conversationGroup || sessionKeyGroupId(ctx?.sessionKey || event?.sessionKey);
}

function rememberInboundMessage(event, ctx, groupId) {
  const body = String(event?.content ?? "").trim();
  if (!body) return;
  recentInboundMessages.push({
    group_id: groupId,
    session_key: ctx?.sessionKey || event?.sessionKey,
    message_id: event?.messageId || event?.metadata?.messageId || ctx?.messageId,
    sender_id: event?.senderId || event?.metadata?.senderId || ctx?.senderId || "",
    sender_name: event?.metadata?.senderName || event?.metadata?.senderUsername || "",
    sender_e164: event?.metadata?.senderE164 || "",
    timestamp: typeof event?.timestamp === "number" ? new Date(event.timestamp).toISOString() : undefined,
    body,
    seen_at: Date.now()
  });
  if (recentInboundMessages.length > 500) recentInboundMessages.splice(0, recentInboundMessages.length - 500);
}

function findRecentInboundMessage(groupIds, text) {
  const body = extractUserAuthoredText(text ?? "");
  if (!body) return undefined;
  for (let index = recentInboundMessages.length - 1; index >= 0; index -= 1) {
    const row = recentInboundMessages[index];
    if (!groupIds.has(row.group_id)) continue;
    if (row.body === body || body.includes(row.body) || row.body.includes(body)) return row;
  }
  return undefined;
}

function appendSuppressedMessageLog(api, ctx, event, metadataBlocks, groupIds, reason, cachedInbound) {
  const convo = conversationMetadata(metadataBlocks);
  const sender = senderMetadata(metadataBlocks);
  const groupId = [...groupIds].find((value) => value?.endsWith("@g.us"));
  if (!groupId) return;

  const cachedDate = cachedInbound?.timestamp ? new Date(cachedInbound.timestamp) : undefined;
  const messageDate = parseConversationTimestamp(convo.timestamp) ?? (cachedDate && !Number.isNaN(cachedDate.getTime()) ? cachedDate : new Date());
  const local = formatWibParts(messageDate);
  const workspaceDir = ctx.workspaceDir || FALLBACK_WORKSPACE_DIR;
  const logPath = join(workspaceDir, "memory", "wa-monitor", `${local.date}.jsonl`);
  const body = extractUserAuthoredText(event.cleanedBody ?? "") || cachedInbound?.body || "";
  const record = {
    schema: "openclaw.wa_monitor_gate.v1",
    timestamp: messageDate.toISOString(),
    logged_at: new Date().toISOString(),
    local_date: local.date,
    time: local.time,
    group_id: groupId,
    session_key: ctx.sessionKey,
    session_id: ctx.sessionId,
    message_id: convo.message_id || cachedInbound?.message_id,
    sender_id: convo.sender_id || sender.id || cachedInbound?.sender_id || cachedInbound?.sender_e164 || "",
    sender_name: sender.name || convo.sender || cachedInbound?.sender_name || "",
    body,
    mentioned_bot: Boolean(convo.was_mentioned || convo.wasMentioned),
    mentioned_target: containsAny(body, TARGET_NUMBERS) || containsAny(body, TARGET_DIGITS),
    suppressed: true,
    reason
  };

  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    api.logger.warn?.(`wa-monitor-gate failed to write monitor log: ${error instanceof Error ? error.message : String(error)}`);
  }
  appendSuppressedSessionTranscript(api, ctx, event, record);
}

const plugin = {
  id: "wa-monitor-gate",
  name: "WhatsApp Monitor Gate",
  description: "Suppress visible replies in monitored WhatsApp groups unless Cici or the monitored number is mentioned.",
  configSchema: () => ({
    type: "object",
    additionalProperties: false,
    properties: {}
  }),
  register(api) {
    if (!EXTENSION_SETTINGS.enabled) {
      api.logger.warn?.(`wa-monitor-gate disabled due to invalid settings in ${ENV_FILE}: ${EXTENSION_SETTINGS.issues.join("; ")}`);
      return;
    }

    api.on("message_received", async (event, ctx) => {
      if (ctx.channelId !== "whatsapp") return;
      const monitoredGroups = resolveMonitoredGroups(api.config);
      const groupId = eventGroupId(event, ctx);
      if (!groupId || !monitoredGroups.has(groupId)) return;
      rememberInboundMessage(event, ctx, groupId);
    });

    api.on("before_agent_reply", async (event, ctx) => {
      if (ctx.channelId !== "whatsapp" && ctx.messageProvider !== "whatsapp") return;

      const monitoredGroups = resolveMonitoredGroups(api.config);
      const metadataBlocks = extractJsonBlocks(event.cleanedBody ?? "");
      const groupIds = new Set([
        sessionKeyGroupId(ctx.sessionKey),
        ...metadataBlocks.map(metadataGroupId)
      ].filter(Boolean));

      const isMonitoredGroup = [...groupIds].some((groupId) => monitoredGroups.has(groupId));
      if (!isMonitoredGroup) return;
      if (messageExplicitlyAllowed(event.cleanedBody ?? "", metadataBlocks)) return;

      const reason = "monitored_whatsapp_group_without_explicit_mention";
      appendSuppressedMessageLog(api, ctx, event, metadataBlocks, groupIds, reason, findRecentInboundMessage(groupIds, event.cleanedBody));
      api.logger.debug?.(`wa-monitor-gate suppressed reply for ${[...groupIds].join(",") || ctx.sessionKey}`);
      return {
        handled: true,
        reply: { text: "NO_REPLY" },
        reason
      };
    }, { priority: 1000 });
  }
};

export default plugin;