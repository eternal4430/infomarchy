import { describe, expect, test } from "bun:test";
import {
  emptyHermesUsageStore, hermesUsageRefreshDue, hermesUsageSummary, parseHermesUsageRows,
  parseHermesUsageStoreText, refreshHermesUsage, HERMES_USAGE_REFRESH_MS, type UsageRunner,
} from "./hermes-usage";

const sqliteJson = (rows: object[]) => JSON.stringify(rows);

describe("parseHermesUsageRows", () => {
  test("parses a well-formed sqlite3 -json result", () => {
    const output = sqliteJson([
      { session_id: "s1", model: "deepseek/deepseek-v4.1-flash", billing_provider: "openrouter", api_call_count: 5, input_tokens: 100, output_tokens: 50, cache_read_tokens: 10, cache_write_tokens: 0, reasoning_tokens: 5, estimated_cost_usd: 0.01, last_seen: 1700000000 },
    ]);
    expect(parseHermesUsageRows(output)).toEqual([{
      sessionId: "s1", model: "deepseek/deepseek-v4.1-flash", billingProvider: "openrouter",
      apiCallCount: 5, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 0,
      reasoningTokens: 5, estimatedCostUsd: 0.01, lastSeen: 1700000000,
    }]);
  });

  test("an empty result set is [] and reads as success with zero rows", () => {
    expect(parseHermesUsageRows("[]")).toEqual([]);
  });

  test("empty output, garbage, or a non-array means the probe failed (null)", () => {
    expect(parseHermesUsageRows("")).toBeNull();
    expect(parseHermesUsageRows("   ")).toBeNull();
    expect(parseHermesUsageRows("not json")).toBeNull();
    expect(parseHermesUsageRows('{"not":"an array"}')).toBeNull();
  });

  test("drops rows with no model and tolerates a mixed-garbage array", () => {
    const output = sqliteJson([{ model: "", input_tokens: 5 }]);
    expect(parseHermesUsageRows(output)).toEqual([]);
    expect(parseHermesUsageRows('[null, "garbage", {"model":"ok","input_tokens":1}]')).toEqual([
      expect.objectContaining({ model: "ok", inputTokens: 1 }),
    ]);
  });
});

describe("refreshHermesUsage", () => {
  test("fetches every host and preserves ok:false with no rows on failure", async () => {
    const runner: UsageRunner = async (cmd) => {
      const host = cmd[cmd.length - 2];
      if (host === "vps") return sqliteJson([{ model: "deepseek/deepseek-v4.1-flash", input_tokens: 10, last_seen: 1700000000 }]);
      return ""; // no db, no sqlite3, or unreachable
    };
    const store = await refreshHermesUsage(emptyHermesUsageStore(), 5000, [{ label: "vps", host: "vps" }, { label: "dead", host: "dead" }], runner);
    expect(store.checkedAt).toBe(5000);
    expect(store.results).toEqual([
      expect.objectContaining({ host: "vps", ok: true, rows: [expect.objectContaining({ model: "deepseek/deepseek-v4.1-flash" })] }),
      expect.objectContaining({ host: "dead", ok: false, rows: [] }),
    ]);
  });

  test("no hosts means no probes", async () => {
    const runner: UsageRunner = async () => { throw new Error("should not be called"); };
    const store = await refreshHermesUsage(emptyHermesUsageStore(), 5000, [], runner);
    expect(store).toEqual({ checkedAt: 5000, results: [] });
  });
});

describe("hermesUsageRefreshDue", () => {
  test("due on a fresh store and after the interval elapses", () => {
    expect(hermesUsageRefreshDue(emptyHermesUsageStore(), 1000)).toBe(true);
    const checked = { checkedAt: 1000, results: [] };
    expect(hermesUsageRefreshDue(checked, 1000 + HERMES_USAGE_REFRESH_MS - 1)).toBe(false);
    expect(hermesUsageRefreshDue(checked, 1000 + HERMES_USAGE_REFRESH_MS)).toBe(true);
  });
});

describe("parseHermesUsageStoreText", () => {
  test("round-trips a store written by refreshHermesUsage", async () => {
    const runner: UsageRunner = async () => sqliteJson([{ session_id: "s1", model: "m", input_tokens: 1, last_seen: 1700000000 }]);
    const store = await refreshHermesUsage(emptyHermesUsageStore(), 5000, [{ label: "vps", host: "vps" }], runner);
    expect(parseHermesUsageStoreText(JSON.stringify(store))).toEqual(store);
  });

  test("degrades to an empty store on missing or malformed input", () => {
    expect(parseHermesUsageStoreText(null)).toEqual(emptyHermesUsageStore());
    expect(parseHermesUsageStoreText("not json")).toEqual(emptyHermesUsageStore());
    expect(parseHermesUsageStoreText("x".repeat(2_000_000))).toEqual(emptyHermesUsageStore());
  });
});

describe("hermesUsageSummary", () => {
  const dayKeys = ["2026-09-16", "2026-09-17", "2026-09-18"];
  // 2026-09-18 00:00:00 UTC-ish; exact tz doesn't matter, only that this
  // lands on dayKeys' last entry via localDayKey's local-time math.
  const todaySeconds = Math.floor(new Date(2026, 8, 18, 12, 0, 0).getTime() / 1000);
  const yesterdaySeconds = Math.floor(new Date(2026, 8, 17, 12, 0, 0).getTime() / 1000);

  test("returns null when there is no successful row anywhere", () => {
    expect(hermesUsageSummary({ checkedAt: 1, results: [{ host: "vps", ok: false, rows: [], checkedAt: 1 }] }, dayKeys)).toBeNull();
  });

  test("aggregates tokens, cost, sessions and day-buckets across hosts", () => {
    const store = {
      checkedAt: 1, results: [
        { host: "vps", ok: true, checkedAt: 1, rows: [
          { sessionId: "s1", model: "deepseek/deepseek-v4.1-flash", billingProvider: "openrouter", apiCallCount: 5, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 0, reasoningTokens: 5, estimatedCostUsd: 0.01, lastSeen: todaySeconds },
          { sessionId: "s1", model: "deepseek/deepseek-v4.1-flash", billingProvider: "openrouter", apiCallCount: 2, inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0.002, lastSeen: yesterdaySeconds },
          { sessionId: "s2", model: "deepseek/deepseek-v4.1-flash", billingProvider: "openrouter", apiCallCount: 1, inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0.0001, lastSeen: todaySeconds },
        ] },
      ],
    };
    const summary = hermesUsageSummary(store, dayKeys)!;
    expect(summary.totalSessions).toBe(2);
    expect(summary.todaySessions).toBe(2);
    expect(summary.totalPrompts).toBe(8);
    expect(summary.todayPrompts).toBe(6);
    expect(summary.costLifetimeUsd).toBeCloseTo(0.0121, 6);
    expect(summary.costTodayUsd).toBeCloseTo(0.0101, 6);
    expect(summary.modelUsage["deepseek/deepseek-v4.1-flash"]).toEqual({ inputTokens: 125, outputTokens: 66, cacheReadInputTokens: 10, cacheCreationInputTokens: 0 });
    expect(summary.modelSessions).toEqual({ "deepseek/deepseek-v4.1-flash": 2 });
    expect(summary.recentDays).toEqual([
      { date: "2026-09-16", messageCount: 0 },
      { date: "2026-09-17", messageCount: 30 },
      { date: "2026-09-18", messageCount: 171 },
    ]);
  });

  test("ignores rows from hosts that failed", () => {
    const store = {
      checkedAt: 1, results: [
        { host: "vps", ok: true, checkedAt: 1, rows: [{ sessionId: "s1", model: "m", billingProvider: "openrouter", apiCallCount: 1, inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0, lastSeen: todaySeconds }] },
        { host: "dead", ok: false, checkedAt: 1, rows: [{ sessionId: "should-not-appear", model: "m", billingProvider: "openrouter", apiCallCount: 99, inputTokens: 99, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0, lastSeen: todaySeconds }] },
      ],
    };
    const summary = hermesUsageSummary(store, dayKeys)!;
    expect(summary.totalPrompts).toBe(1);
    expect(summary.totalSessions).toBe(1);
  });
});
