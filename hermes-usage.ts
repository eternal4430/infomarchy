// Reads Hermes's own per-model billing ledger (~/.hermes/state.db,
// session_model_usage table) over SSH, so the desk can show OpenRouter-routed
// model usage (Deepseek and anything else Hermes talks to) the same way it
// shows Claude/Codex usage — without a second API key or login. Hermes
// already resolves live OpenRouter pricing into estimated_cost_usd per row
// (cost_source: provider_models_api). See hermesUsageValueOverride() in the
// collector for why that number is used instead of Infomarchy's own pinned
// pricing.json: that snapshot has no entries for most OpenRouter model ids,
// and Hermes's live-priced figure is more current than a pinned one anyway.
//
// Shares FleetHostConfig from fleet-remote.ts — this reads from the same
// configured hosts (INFOMARCHY_FLEET_HOSTS), not a second env var. A host
// with no ~/.hermes/state.db, or no sqlite3 on PATH, degrades to "no rows"
// exactly like an unreachable host does in fleet-remote.ts.

import type { FleetHostConfig } from "./fleet-remote";

export type UsageRunner = (cmd: string[], timeoutMs: number) => Promise<string>;

export type HermesUsageRow = {
  sessionId: string; model: string; billingProvider: string;
  apiCallCount: number; inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number;
  estimatedCostUsd: number; lastSeen: number; // unix seconds, as sqlite stores it
};
export type HermesUsageHostResult = { host: string; ok: boolean; rows: HermesUsageRow[]; checkedAt: number };
export type HermesUsageStore = { checkedAt: number; results: HermesUsageHostResult[] };

export const HERMES_USAGE_REFRESH_MS = 60_000;
export const HERMES_USAGE_SSH_TIMEOUT_MS = 5_000;
const MAX_ROWS_PER_HOST = 2000;
const MAX_HOSTS = 8;
const USAGE_STORE_MAX_BYTES = 1_048_576;

// Fixed query, never built from configuration — there is nothing here an
// entry in INFOMARCHY_FLEET_HOSTS could inject into. Ordered newest-first so
// a row cap loses only the oldest history, never the most recent activity.
const HERMES_USAGE_QUERY =
  "SELECT session_id, model, billing_provider, api_call_count, input_tokens, output_tokens, " +
  "cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd, last_seen " +
  `FROM session_model_usage ORDER BY last_seen DESC LIMIT ${MAX_ROWS_PER_HOST};`;

function sshArgs(host: string): string[] {
  return [
    "ssh",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=4",
    "-o", "ServerAliveInterval=4",
    "-o", "ServerAliveCountMax=1",
    host,
    // $HOME expands on the remote shell, not here — there is no way to read
    // a remote HERMES_HOME override without a second round trip, so this
    // only covers the default install location, same limitation ps-based
    // detection in fleet-remote.ts already accepts for argv precision.
    `test -f "$HOME/.hermes/state.db" && sqlite3 -json -readonly "$HOME/.hermes/state.db" '${HERMES_USAGE_QUERY}'`,
  ];
}

function finite(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// null means "could not read the ledger" (unreachable host, no sqlite3, no
// db); [] means "read it, zero rows" — sqlite3 -json prints [] for an empty
// result set, so this distinction is real, not guessed.
export function parseHermesUsageRows(output: string): HermesUsageRow[] | null {
  const text = output.trim();
  if (!text) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const rows: HermesUsageRow[] = [];
  for (const raw of parsed.slice(0, MAX_ROWS_PER_HOST)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const model = typeof r.model === "string" ? r.model.trim().slice(0, 96) : "";
    if (!model) continue;
    rows.push({
      sessionId: typeof r.session_id === "string" ? r.session_id.slice(0, 128) : "",
      model,
      billingProvider: typeof r.billing_provider === "string" ? r.billing_provider.slice(0, 32) : "",
      apiCallCount: Math.floor(finite(r.api_call_count)),
      inputTokens: Math.floor(finite(r.input_tokens)),
      outputTokens: Math.floor(finite(r.output_tokens)),
      cacheReadTokens: Math.floor(finite(r.cache_read_tokens)),
      cacheWriteTokens: Math.floor(finite(r.cache_write_tokens)),
      reasoningTokens: Math.floor(finite(r.reasoning_tokens)),
      estimatedCostUsd: finite(r.estimated_cost_usd),
      lastSeen: finite(r.last_seen),
    });
  }
  return rows;
}

async function fetchHost(host: string, runner: UsageRunner, now: number): Promise<HermesUsageHostResult> {
  try {
    const output = await runner(sshArgs(host), HERMES_USAGE_SSH_TIMEOUT_MS);
    const rows = parseHermesUsageRows(output);
    return { host, ok: rows !== null, rows: rows || [], checkedAt: now };
  } catch {
    return { host, ok: false, rows: [], checkedAt: now };
  }
}

export function emptyHermesUsageStore(): HermesUsageStore {
  return { checkedAt: 0, results: [] };
}

export function hermesUsageRefreshDue(store: HermesUsageStore, now: number): boolean {
  const last = store.checkedAt || 0;
  if (!(last > 0) || last > now) return true;
  return now - last >= HERMES_USAGE_REFRESH_MS;
}

export async function refreshHermesUsage(store: HermesUsageStore, now: number, hosts: FleetHostConfig[], runner: UsageRunner): Promise<HermesUsageStore> {
  const capped = hosts.slice(0, MAX_HOSTS);
  if (!capped.length) return { checkedAt: now, results: [] };
  const results = await Promise.all(capped.map(h => fetchHost(h.host, runner, now)));
  return { checkedAt: now, results };
}

function normalizeRow(raw: unknown): HermesUsageRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const model = typeof r.model === "string" ? r.model.slice(0, 96) : "";
  if (!model) return null;
  return {
    sessionId: typeof r.sessionId === "string" ? r.sessionId.slice(0, 128) : "",
    model,
    billingProvider: typeof r.billingProvider === "string" ? r.billingProvider.slice(0, 32) : "",
    apiCallCount: Math.floor(finite(r.apiCallCount)),
    inputTokens: Math.floor(finite(r.inputTokens)),
    outputTokens: Math.floor(finite(r.outputTokens)),
    cacheReadTokens: Math.floor(finite(r.cacheReadTokens)),
    cacheWriteTokens: Math.floor(finite(r.cacheWriteTokens)),
    reasoningTokens: Math.floor(finite(r.reasoningTokens)),
    estimatedCostUsd: finite(r.estimatedCostUsd),
    lastSeen: finite(r.lastSeen),
  };
}

function normalizeHostResult(raw: unknown): HermesUsageHostResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const host = typeof r.host === "string" ? r.host.slice(0, 253) : "";
  if (!host) return null;
  const rows = Array.isArray(r.rows) ? r.rows.slice(0, MAX_ROWS_PER_HOST).map(normalizeRow).filter((x): x is HermesUsageRow => x !== null) : [];
  return { host, ok: r.ok === true, rows, checkedAt: finite(r.checkedAt) };
}

// Disk-persisted between collector ticks, same reasoning as fleet-remote.ts's
// store: collector.ts is re-invoked fresh every 5s and has no other place to
// keep a refresh clock.
export function normalizeHermesUsageStore(raw: unknown): HermesUsageStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyHermesUsageStore();
  const source = raw as Record<string, unknown>;
  const results = Array.isArray(source.results)
    ? source.results.slice(0, MAX_HOSTS).map(normalizeHostResult).filter((r): r is HermesUsageHostResult => r !== null)
    : [];
  return { checkedAt: finite(source.checkedAt), results };
}

export function parseHermesUsageStoreText(text: string | null | undefined): HermesUsageStore {
  if (typeof text !== "string" || !text || text.length > USAGE_STORE_MAX_BYTES) return emptyHermesUsageStore();
  try { return normalizeHermesUsageStore(JSON.parse(text)); } catch { return emptyHermesUsageStore(); }
}

// Mirrors collector.ts's own localDayKey() (year-month-day in the viewer's
// local time) rather than importing it — importing from collector.ts here
// would create the same import cycle providerOf() avoids in fleet-remote.ts,
// and the function is four lines.
function localDayKey(stampMs: number): string {
  const d = new Date(stampMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export type HermesUsageSummary = {
  modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>;
  todayTokensByModel: Record<string, number>;
  modelSessions: Record<string, number>;
  recentDays: { date: string; messageCount: number }[];
  todayPrompts: number; totalPrompts: number;
  todaySessions: number; totalSessions: number;
  todayTotalTokens: number;
  costLifetimeUsd: number; costTodayUsd: number;
};

// Aggregates every host's rows into the shape normalizeUsage() (collector.ts)
// expects as input, plus the two cost totals normalizeUsage() cannot derive
// itself (see the module header). dayKeys is the dashboard's existing 7
// aligned local days (heatDays.map(localDayKey) at the call site) so this
// shares one x-axis with every other provider's trend line.
export function hermesUsageSummary(store: HermesUsageStore, dayKeys: string[]): HermesUsageSummary | null {
  const rows = store.results.filter(r => r.ok).flatMap(r => r.rows);
  if (!rows.length) return null;
  const today = dayKeys[dayKeys.length - 1];
  const modelUsage: HermesUsageSummary["modelUsage"] = {};
  const dayTotals = new Map<string, number>();
  const todayModelTotals = new Map<string, number>();
  const sessionIds = new Set<string>();
  const todaySessionIds = new Set<string>();
  const modelSessionIds = new Map<string, Set<string>>();
  let totalPrompts = 0, todayPrompts = 0, costLifetimeUsd = 0, costTodayUsd = 0;

  for (const row of rows) {
    // reasoning tokens are billed as output by every provider Hermes talks
    // to; there is no separate slot for them in the shared TokenUsage shape.
    const tokens = row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens + row.reasoningTokens;
    const entry = modelUsage[row.model] || (modelUsage[row.model] = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    entry.inputTokens += row.inputTokens;
    entry.outputTokens += row.outputTokens + row.reasoningTokens;
    entry.cacheReadInputTokens += row.cacheReadTokens;
    entry.cacheCreationInputTokens += row.cacheWriteTokens;

    totalPrompts += row.apiCallCount;
    costLifetimeUsd += row.estimatedCostUsd;
    if (row.sessionId) {
      sessionIds.add(row.sessionId);
      let modelSet = modelSessionIds.get(row.model);
      if (!modelSet) { modelSet = new Set(); modelSessionIds.set(row.model, modelSet); }
      modelSet.add(row.sessionId);
    }

    const date = row.lastSeen > 0 ? localDayKey(row.lastSeen * 1000) : "";
    if (date) dayTotals.set(date, (dayTotals.get(date) || 0) + tokens);
    if (date && date === today) {
      todayPrompts += row.apiCallCount;
      costTodayUsd += row.estimatedCostUsd;
      if (row.sessionId) todaySessionIds.add(row.sessionId);
      todayModelTotals.set(row.model, (todayModelTotals.get(row.model) || 0) + tokens);
    }
  }

  const modelSessions: Record<string, number> = {};
  for (const [model, ids] of modelSessionIds) modelSessions[model] = ids.size;

  return {
    modelUsage,
    todayTokensByModel: Object.fromEntries(todayModelTotals),
    modelSessions,
    recentDays: dayKeys.map(date => ({ date, messageCount: dayTotals.get(date) || 0 })),
    todayPrompts, totalPrompts,
    todaySessions: todaySessionIds.size, totalSessions: sessionIds.size,
    todayTotalTokens: dayTotals.get(today) || 0,
    costLifetimeUsd, costTodayUsd,
  };
}
