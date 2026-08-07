import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PROVIDER_IDS, type ParsedSession, type ProviderId } from "../shared/types.ts";
import { SearchDatabase } from "./database.ts";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const remove of cleanup.splice(0)) await remove();
});

const createDatabase = async (): Promise<SearchDatabase> => {
  const directory = await mkdtemp(join(tmpdir(), "ai-session-search-db-"));
  const database = new SearchDatabase(join(directory, "search.db"));
  cleanup.push(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  return database;
};

const sampleSession = (): ParsedSession => ({
  sessionKey: "codex:session-1",
  sourceSessionId: "session-1",
  provider: "codex",
  filePath: "/tmp/session-1.jsonl",
  projectPath: "/workspace/demo",
  originalTitle: "排查订单回调",
  startedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
  messages: [
    {
      index: 0,
      role: "user",
      content: "帮我排查订单支付回调",
      timestamp: "2026-01-01T00:00:00.000Z",
    },
    {
      index: 1,
      role: "assistant",
      content: "问题位于 OrderCallbackService",
      timestamp: "2026-01-01T00:01:00.000Z",
    },
  ],
});

describe("SearchDatabase", () => {
  test("removes indexes left by providers that are no longer supported", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-session-search-removed-providers-"));
    const path = join(directory, "search.db");
    new SearchDatabase(path).close();

    const legacy = new DatabaseSync(path);
    const insertSession = legacy.prepare(`
      INSERT INTO sessions (
        session_key, source_session_id, provider, file_path, project_path,
        original_title, started_at, updated_at, message_count,
        file_mtime_ms, file_size, parser_version, indexed_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 1, 1, 1, 1, 1)
    `);
    for (const provider of ["pi", "openclaw", "hermes", "droid"]) {
      const sessionKey = `${provider}:legacy`;
      insertSession.run(
        sessionKey,
        "legacy",
        provider,
        `/tmp/${provider}.jsonl`,
        `${provider} legacy`,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      legacy.prepare(`
        INSERT INTO messages_fts (
          session_key, provider, project_path, role, timestamp, message_index, content
        ) VALUES (?, ?, '', 'assistant', '', 0, 'removed provider content')
      `).run(sessionKey, provider);
    }
    legacy.close();

    const database = new SearchDatabase(path);
    expect(database.search({ query: "removed provider content" })).toEqual([]);
    expect(Object.values(database.countSessions()).reduce((sum, count) => sum + count, 0)).toBe(0);
    database.close();

    const verification = new DatabaseSync(path, { readOnly: true });
    expect(verification.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toMatchObject({ count: 0 });
    expect(verification.prepare("SELECT COUNT(*) AS count FROM messages_fts").get()).toMatchObject({ count: 0 });
    verification.close();
    await rm(directory, { recursive: true, force: true });
  });

  test("migrates an existing metadata table without losing rows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-session-search-migration-"));
    const path = join(directory, "search.db");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE session_metadata (
        session_key TEXT PRIMARY KEY,
        custom_title TEXT,
        favorite INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO session_metadata(session_key, custom_title, favorite, updated_at)
      VALUES ('codex:legacy', '旧名称', 1, 1);
    `);
    legacy.close();

    const database = new SearchDatabase(path);
    cleanup.push(async () => {
      database.close();
      await rm(directory, { recursive: true, force: true });
    });
    expect(database.createCollection("迁移后收藏夹").name).toBe("迁移后收藏夹");
  });

  test("supports trigram and two-character fallback search", async () => {
    const database = await createDatabase();
    database.upsertSession(sampleSession(), {
      provider: "codex",
      path: "/tmp/session-1.jsonl",
      mtimeMs: 1,
      size: 100,
    });

    expect(database.search({ query: "支付回调" })[0]?.sessionKey).toBe("codex:session-1");
    expect(database.search({ query: "订单" })[0]?.sessionKey).toBe("codex:session-1");
    expect(database.search({ query: "CallbackService" })[0]?.messageIndex).toBe(1);
  });

  test("requires every search term across the whole session", async () => {
    const database = await createDatabase();
    const matching = {
      ...sampleSession(),
      messages: [
        {
          index: 0,
          role: "user" as const,
          content: "请把最新版本推送到仓库",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          index: 1,
          role: "assistant" as const,
          content: "接下来部署到家中服务器",
          timestamp: "2026-01-01T00:01:00.000Z",
        },
      ],
    };
    const partial = {
      ...sampleSession(),
      sessionKey: "codex:session-2",
      sourceSessionId: "session-2",
      filePath: "/tmp/session-2.jsonl",
      messages: [{
        index: 0,
        role: "user" as const,
        content: "只记录了推送操作",
        timestamp: "2026-01-02T00:00:00.000Z",
      }],
    };
    for (const [session, mtimeMs] of [[matching, 1], [partial, 2]] as const) {
      database.upsertSession(session, {
        provider: "codex",
        path: session.filePath,
        mtimeMs,
        size: 100,
      });
    }

    const results = database.search({ query: "推送 家中服务器" });
    expect(results.map((result) => result.sessionKey)).toEqual([matching.sessionKey]);
    expect(results[0]?.messageIndex).toBe(0);
  });

  test("supports quoted phrases and combines session IDs with content terms", async () => {
    const database = await createDatabase();
    const sessionId = "019fc543-bed2-7e21-bc69-35cb2091fcae";
    const session = {
      ...sampleSession(),
      sessionKey: `codex:${sessionId}`,
      sourceSessionId: sessionId,
      filePath: `/tmp/${sessionId}.jsonl`,
      messages: [{
        index: 0,
        role: "user" as const,
        content: "GitHub Actions 已经部署到家中服务器",
        timestamp: "2026-01-01T00:00:00.000Z",
      }],
    };
    database.upsertSession(session, {
      provider: "codex",
      path: session.filePath,
      mtimeMs: 1,
      size: 100,
    });

    expect(database.search({ query: '"GitHub Actions" 家中服务器' })[0]?.sessionKey).toBe(session.sessionKey);
    expect(database.search({ query: "35cb2091 家中服务器" })[0]?.sessionKey).toBe(session.sessionKey);
    expect(database.search({ query: '"GitHub deployment" 家中服务器' })).toEqual([]);
  });

  test("loads provider manifests and applies multiple session updates as one batch", async () => {
    const database = await createDatabase();
    const first = sampleSession();
    const second: ParsedSession = {
      ...sampleSession(),
      sessionKey: "codex:session-2",
      sourceSessionId: "session-2",
      filePath: "/tmp/session-2.jsonl",
      originalTitle: "第二个会话",
      messages: [{
        index: 0,
        role: "user",
        content: "批量索引关键字",
        timestamp: "2026-01-02T00:00:00.000Z",
      }],
    };

    const result = database.applyProviderIndexBatch({
      provider: "codex",
      visibleFiles: new Set([first.filePath, second.filePath]),
      removeSessionKeys: new Set(),
      upserts: [
        { session: first, file: { provider: "codex", path: first.filePath, mtimeMs: 1, size: 10 }, parserVersion: 1 },
        { session: second, file: { provider: "codex", path: second.filePath, mtimeMs: 2, size: 20 }, parserVersion: 1 },
      ],
    });

    expect(result).toEqual({ indexed: 2, removed: 0, errors: [] });
    expect(database.getIndexedFiles("codex")).toEqual(new Map([
      [first.filePath, { sessionKey: first.sessionKey, mtimeMs: 1, size: 10, parserVersion: 1 }],
      [second.filePath, { sessionKey: second.sessionKey, mtimeMs: 2, size: 20, parserVersion: 1 }],
    ]));
    expect(database.search({ query: "批量索引关键字" })[0]?.sessionKey).toBe(second.sessionKey);
  });

  test("searches sessions by full or partial session ID", async () => {
    const database = await createDatabase();
    const sessionId = "019fc543-bed2-7e21-bc69-35cb2091fcae";
    const session = {
      ...sampleSession(),
      sessionKey: `codex:${sessionId}`,
      sourceSessionId: sessionId,
      filePath: `/tmp/${sessionId}.jsonl`,
    };
    database.upsertSession(session, {
      provider: "codex",
      path: session.filePath,
      mtimeMs: 1,
      size: 100,
    });

    expect(database.search({ query: sessionId })[0]).toMatchObject({
      sessionKey: `codex:${sessionId}`,
      sourceSessionId: sessionId,
    });
    expect(database.search({ query: "35cb2091" })[0]?.sessionKey).toBe(`codex:${sessionId}`);
  });

  test("persists custom title and favorite metadata and searches the custom title", async () => {
    const database = await createDatabase();
    database.upsertSession(sampleSession(), {
      provider: "codex",
      path: "/tmp/session-1.jsonl",
      mtimeMs: 1,
      size: 100,
    });

    const updated = database.updateMetadata("codex:session-1", {
      customTitle: "QC schema design v2",
      favorite: true,
    });

    expect(updated?.displayTitle).toBe("QC schema design v2");
    expect(updated?.favorite).toBe(true);
    expect(database.search({ query: "schema" })[0]).toMatchObject({
      sessionKey: "codex:session-1",
      role: "title",
      favorite: true,
    });
  });

  test("filters sessions and search results to renamed sessions", async () => {
    const database = await createDatabase();
    const first = sampleSession();
    const second = {
      ...sampleSession(),
      sessionKey: "codex:session-2",
      sourceSessionId: "session-2",
      filePath: "/tmp/session-2.jsonl",
    };
    database.upsertSession(first, {
      provider: "codex",
      path: first.filePath,
      mtimeMs: 1,
      size: 100,
    });
    database.upsertSession(second, {
      provider: "codex",
      path: second.filePath,
      mtimeMs: 1,
      size: 100,
    });
    database.updateMetadata(first.sessionKey, { customTitle: "已命名会话" });

    expect(database.listSessions({ renamedOnly: true }).map((item) => item.sessionKey)).toEqual([
      first.sessionKey,
    ]);
    expect(
      new Set(database.search({ query: "支付回调", renamedOnly: true }).map((item) => item.sessionKey)),
    ).toEqual(new Set([first.sessionKey]));
  });

  test("creates, renames, filters, assigns, and deletes collections", async () => {
    const database = await createDatabase();
    const session = sampleSession();
    database.upsertSession(session, {
      provider: "codex",
      path: session.filePath,
      mtimeMs: 1,
      size: 100,
    });

    const collection = database.createCollection("生产问题");
    expect(collection).toMatchObject({ name: "生产问题", sessionCount: 0, contextCount: 0 });

    const assigned = database.updateMetadata(session.sessionKey, { collectionId: collection.id });
    expect(assigned?.collectionId).toBe(collection.id);
    expect(database.listSessions({ collectionId: collection.id })).toHaveLength(1);
    expect(database.listSessions({ collectionId: null })).toHaveLength(0);
    expect(database.listCollections()[0]).toMatchObject({
      id: collection.id,
      name: "生产问题",
      sessionCount: 1,
    });
    expect(database.search({ query: "支付回调", collectionId: collection.id })).not.toHaveLength(0);

    expect(database.renameCollection(collection.id, "线上排查")?.name).toBe("线上排查");
    expect(database.deleteCollection(collection.id)).toBe(true);
    expect(database.getSession(session.sessionKey)?.session.collectionId).toBeNull();
  });

  test("creates, updates, searches, copies, and deletes context snippets", async () => {
    const database = await createDatabase();
    const collection = database.createCollection("客服专家");
    const created = database.createContextSnippet({
      title: "客服专家项目拓扑",
      content: "/workspace/performance-mcp\n这是客服专家 MCP，包含 POP 和 Self。",
      favorite: true,
      collectionId: collection.id,
    });

    expect(created).toMatchObject({
      title: "客服专家项目拓扑",
      favorite: true,
      collectionId: collection.id,
      copyCount: 0,
    });
    expect(database.listCollections()[0]).toMatchObject({
      sessionCount: 0,
      contextCount: 1,
    });
    expect(database.listContextSnippets({ query: "performance-mcp" })[0]).toMatchObject({
      id: created.id,
      title: "客服专家项目拓扑",
    });
    expect(database.listContextSnippets({ query: "专家" })[0]?.id).toBe(created.id);

    const updated = database.updateContextSnippet(created.id, {
      title: "客服专家完整上下文",
      content: "整块上下文原样保存\nshopId=1000225981",
      favorite: false,
      collectionId: null,
    });
    expect(updated).toMatchObject({
      title: "客服专家完整上下文",
      content: "整块上下文原样保存\nshopId=1000225981",
      favorite: false,
      collectionId: null,
    });
    expect(database.listContextSnippets({ query: "performance-mcp" })).toEqual([]);
    expect(database.listContextSnippets({ query: "1000225981" })[0]?.id).toBe(created.id);

    expect(database.recordContextSnippetCopy(created.id)).toMatchObject({ copyCount: 1 });
    expect(database.recordContextSnippetCopy(created.id)).toMatchObject({ copyCount: 2 });
    expect(database.deleteContextSnippet(created.id)).toBe(true);
    expect(database.getContextSnippet(created.id)).toBeNull();
  });

  test("sorts context snippets by favorites, smart score, time, and copy count", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const database = await createDatabase();
      const older = database.createContextSnippet({ title: "常用旧上下文", content: "old" });
      for (let index = 0; index < 4; index += 1) database.recordContextSnippetCopy(older.id);

      vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
      const newer = database.createContextSnippet({ title: "新上下文", content: "new" });
      const favorite = database.createContextSnippet({
        title: "收藏上下文",
        content: "favorite",
        favorite: true,
      });

      expect(database.listContextSnippets({ sort: "smart" }).map((item) => item.id)).toEqual([
        favorite.id,
        older.id,
        newer.id,
      ]);
      expect(database.listContextSnippets({ sort: "created-desc" }).map((item) => item.id)).toEqual([
        favorite.id,
        newer.id,
        older.id,
      ]);
      expect(database.listContextSnippets({ sort: "copies-desc" }).map((item) => item.id)).toEqual([
        favorite.id,
        older.id,
        newer.id,
      ]);
      expect(database.listContextSnippets({ favoritesOnly: true })).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("removes context assignments when a shared collection is deleted", async () => {
    const database = await createDatabase();
    const collection = database.createCollection("共享收藏夹");
    const snippet = database.createContextSnippet({
      title: "上下文",
      content: "正文",
      collectionId: collection.id,
    });

    expect(database.deleteCollection(collection.id)).toBe(true);
    expect(database.getContextSnippet(snippet.id)?.collectionId).toBeNull();
  });

  test("provides and persists provider-specific resume command templates", async () => {
    const database = await createDatabase();

    expect(database.getResumeCommandTemplates()).toMatchObject({
      claude: "cd {cwd} && claude --resume {sessionId}",
      codex: "cd {cwd} && codex resume {sessionId}",
    });

    expect(database.updateResumeCommandTemplate("codex", "yolo").codex).toBe("yolo");
    expect(database.getResumeCommandTemplates().codex).toBe("yolo");
  });

  test("provides and persists terminal launch settings", async () => {
    const database = await createDatabase();

    expect(database.getTerminalSettings("darwin")).toMatchObject({
      terminal: "terminal",
      customPath: null,
      shellPath: expect.stringMatching(/^\//),
    });
    expect(
      database.updateTerminalSettings(
        {
          terminal: "custom",
          customPath: "/Applications/Ghostty.app",
          shellPath: "/bin/bash",
        },
        "darwin",
      ),
    ).toEqual({
      terminal: "custom",
      customPath: "/Applications/Ghostty.app",
      shellPath: "/bin/bash",
    });
    expect(database.getTerminalSettings("darwin")).toEqual({
      terminal: "custom",
      customPath: "/Applications/Ghostty.app",
      shellPath: "/bin/bash",
    });
  });

  test("uses Windows Terminal and PATH-resolved PowerShell defaults on Windows", async () => {
    const database = await createDatabase();

    expect(database.getTerminalSettings("win32")).toEqual({
      terminal: "windows-terminal",
      customPath: null,
      shellPath: "powershell.exe",
    });
    expect(
      database.updateTerminalSettings(
        { terminal: "powershell", customPath: null, shellPath: "pwsh.exe" },
        "win32",
      ),
    ).toEqual({ terminal: "powershell", customPath: null, shellPath: "pwsh.exe" });
    expect(database.getTerminalSettings("win32")).toEqual({
      terminal: "powershell",
      customPath: null,
      shellPath: "pwsh.exe",
    });
  });

  test("persists provider source paths and enabled states without changing defaults", async () => {
    const database = await createDatabase();
    const defaultHomes = Object.fromEntries(
      PROVIDER_IDS.map((provider) => [provider, `/defaults/${provider}`]),
    ) as Record<ProviderId, string>;
    const defaultProviders = new Set<ProviderId>(PROVIDER_IDS);

    expect(database.getProviderSourceSettings(defaultHomes, defaultProviders)).toContainEqual({
      provider: "codex",
      enabled: true,
      home: "/defaults/codex",
      defaultHome: "/defaults/codex",
      customized: false,
    });

    database.updateProviderSourceSetting("codex", {
      enabled: false,
      home: "/archives/codex",
    });
    expect(database.getProviderSourceSettings(defaultHomes, defaultProviders)).toContainEqual({
      provider: "codex",
      enabled: false,
      home: "/archives/codex",
      defaultHome: "/defaults/codex",
      customized: true,
    });

    database.updateProviderSourceSetting("codex", { enabled: true, home: null });
    expect(database.getProviderSourceSettings(defaultHomes, defaultProviders)).toContainEqual({
      provider: "codex",
      enabled: true,
      home: "/defaults/codex",
      defaultHome: "/defaults/codex",
      customized: false,
    });
  });

  test("migrates the two-provider constraint and indexes a new provider", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-session-search-provider-migration-"));
    const path = join(directory, "search.db");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE sessions (
        session_key TEXT PRIMARY KEY, source_session_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex')),
        file_path TEXT NOT NULL UNIQUE, project_path TEXT, original_title TEXT NOT NULL,
        started_at TEXT NOT NULL, updated_at TEXT NOT NULL, message_count INTEGER NOT NULL,
        file_mtime_ms INTEGER NOT NULL, file_size INTEGER NOT NULL, indexed_at INTEGER NOT NULL
      );
    `);
    legacy.close();
    const database = new SearchDatabase(path);
    cleanup.push(async () => {
      database.close();
      await rm(directory, { recursive: true, force: true });
    });
    const session = { ...sampleSession(), sessionKey: "cursor:session-1", provider: "cursor" as const };
    database.upsertSession(session, { provider: "cursor", path: session.filePath, mtimeMs: 1, size: 100 });
    expect(database.search({ query: "支付回调", provider: "cursor" })[0]?.provider).toBe("cursor");
  });
});
