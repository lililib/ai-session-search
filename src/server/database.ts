import { DatabaseSync } from "node:sqlite";
import { isAbsolute } from "node:path";
import type {
  CollectionSummary,
  ContextSnippetDetail,
  ContextSnippetSort,
  ContextSnippetSummary,
  NormalizedMessage,
  ParsedSession,
  ProviderId,
  ProviderSourceSetting,
  ResumeCommandTemplates,
  SearchResult,
  SessionSummary,
  TerminalSettings,
} from "../shared/types.ts";
import { DEFAULT_RESUME_COMMAND_TEMPLATES } from "../shared/resumeCommand.ts";
import { isProviderId } from "../shared/providers.ts";
import { PROVIDER_IDS } from "../shared/types.ts";
import { TERMINAL_IDS } from "../shared/types.ts";
import { parseSearchTerms } from "../shared/searchQuery.ts";
import {
  defaultTerminalSettings,
  isValidShellReference,
  normalizeRuntimePlatform,
  terminalIdsForPlatform,
} from "../shared/terminal.ts";
import {
  escapeFtsQuery,
  escapeLikeQuery,
  initializeSearchDatabase,
  nullableStringColumn,
  numberColumn,
  providerColumn,
  stringColumn,
  toSessionSummary,
  type SqlRow,
  type SqlValue,
} from "./databaseCore.ts";
import type { SessionFile } from "./providers/types.ts";

const contextPreview = (content: string, query = ""): string => {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchIndex = normalizedQuery === "" ? -1 : content.toLocaleLowerCase().indexOf(normalizedQuery);
  const start = Math.max(0, matchIndex < 0 ? 0 : matchIndex - 60);
  const end = Math.min(content.length, start + 220);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
};

const toContextSnippetDetail = (row: SqlRow, query = ""): ContextSnippetDetail => {
  const content = stringColumn(row, "content");
  return {
    id: numberColumn(row, "id"),
    title: stringColumn(row, "title"),
    content,
    preview: contextPreview(content, query),
    favorite: numberColumn(row, "favorite") === 1,
    collectionId:
      row.collection_id === null || row.collection_id === undefined
        ? null
        : numberColumn(row, "collection_id"),
    copyCount: numberColumn(row, "copy_count"),
    lastCopiedAt:
      row.last_copied_at === null || row.last_copied_at === undefined
        ? null
        : numberColumn(row, "last_copied_at"),
    createdAt: numberColumn(row, "created_at"),
    updatedAt: numberColumn(row, "updated_at"),
  };
};

const contextSmartScore = (snippet: ContextSnippetSummary, now: number): number => {
  const ageDays = Math.max(0, now - snippet.createdAt) / 86_400_000;
  return 3 * Math.log2(snippet.copyCount + 1) + 5 / (1 + ageDays / 30);
};

const compareNullableTimeDesc = (left: number | null, right: number | null): number =>
  (right ?? Number.NEGATIVE_INFINITY) - (left ?? Number.NEGATIVE_INFINITY);

type SearchRowMatch = {
  row: SqlRow;
  terms: Set<number>;
};

type SessionSearchMatch = {
  terms: Set<number>;
  rows: Map<string, SearchRowMatch>;
};

const searchRowKey = (row: SqlRow): string =>
  `${numberColumn(row, "message_index")}:${stringColumn(row, "role")}:${stringColumn(row, "content")}`;

const isSessionIdRow = (row: SqlRow): boolean =>
  numberColumn(row, "message_index") < 0 &&
  stringColumn(row, "content") === stringColumn(row, "source_session_id");

const compareSearchRows = (left: SearchRowMatch, right: SearchRowMatch): number => {
  const termDifference = right.terms.size - left.terms.size;
  if (termDifference !== 0) return termDifference;
  const messageDifference = Number(isSessionIdRow(left.row)) - Number(isSessionIdRow(right.row));
  if (messageDifference !== 0) return messageDifference;
  const roleWeight = (row: SqlRow): number => {
    const role = stringColumn(row, "role");
    return role === "title" ? 2 : role === "user" ? 1 : 0;
  };
  const roleDifference = roleWeight(right.row) - roleWeight(left.row);
  if (roleDifference !== 0) return roleDifference;
  return numberColumn(left.row, "rank") - numberColumn(right.row, "rank");
};

const firstSearchTermIndex = (content: string, terms: string[]): number => {
  const normalizedContent = content.toLocaleLowerCase();
  let firstIndex = -1;
  for (const term of terms) {
    const index = normalizedContent.indexOf(term.toLocaleLowerCase());
    if (index >= 0 && (firstIndex < 0 || index < firstIndex)) firstIndex = index;
  }
  return firstIndex;
};

export class SearchDatabase {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    initializeSearchDatabase(this.#db);
  }

  close(): void {
    this.#db.close();
  }

  getAppSetting(key: string): string | null {
    const row = this.#db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as SqlRow | undefined;
    return row === undefined ? null : stringColumn(row, "value");
  }

  setAppSetting(key: string, value: string): void {
    this.#db.prepare(`
      INSERT INTO app_settings(key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(key, value, Date.now());
  }

  getIndexedFile(path: string): {
    sessionKey: string;
    mtimeMs: number;
    size: number;
    parserVersion: number;
  } | null {
    const row = this.#db
      .prepare(
        "SELECT session_key, file_mtime_ms, file_size, parser_version FROM sessions WHERE file_path = ?",
      )
      .get(path) as SqlRow | undefined;
    if (row === undefined) return null;
    return {
      sessionKey: stringColumn(row, "session_key"),
      mtimeMs: numberColumn(row, "file_mtime_ms"),
      size: numberColumn(row, "file_size"),
      parserVersion: numberColumn(row, "parser_version"),
    };
  }

  getIndexedFiles(provider: ProviderId): Map<string, {
    sessionKey: string;
    mtimeMs: number;
    size: number;
    parserVersion: number;
  }> {
    const rows = this.#db
      .prepare(
        "SELECT session_key, file_path, file_mtime_ms, file_size, parser_version FROM sessions WHERE provider = ? ORDER BY file_path",
      )
      .all(provider) as SqlRow[];
    return new Map(rows.map((row) => [
      stringColumn(row, "file_path"),
      {
        sessionKey: stringColumn(row, "session_key"),
        mtimeMs: numberColumn(row, "file_mtime_ms"),
        size: numberColumn(row, "file_size"),
        parserVersion: numberColumn(row, "parser_version"),
      },
    ]));
  }

  removeSessionIndex(sessionKey: string): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("DELETE FROM sessions WHERE session_key = ?").run(sessionKey);
      this.#db.prepare("DELETE FROM messages_fts WHERE session_key = ?").run(sessionKey);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertSession(session: ParsedSession, file: SessionFile, parserVersion = 1): void {
    const result = this.applyProviderIndexBatch({
      provider: session.provider,
      visibleFiles: null,
      removeSessionKeys: new Set(),
      upserts: [{ session, file, parserVersion }],
    });
    const failure = result.errors[0];
    if (failure !== undefined) throw new Error(failure.error);
  }

  applyProviderIndexBatch(options: {
    provider: ProviderId;
    visibleFiles: ReadonlySet<string> | null;
    removeSessionKeys: ReadonlySet<string>;
    retainSessionKeys?: ReadonlySet<string>;
    upserts: Array<{ session: ParsedSession; file: SessionFile; parserVersion: number }>;
  }): { indexed: number; removed: number; errors: Array<{ path: string; error: string }> } {
    for (const { session, file } of options.upserts) {
      if (session.provider !== options.provider || file.provider !== options.provider) {
        throw new Error(`Cannot apply ${session.provider}/${file.provider} session to ${options.provider} batch`);
      }
    }
    const insertSession = this.#db.prepare(`
      INSERT INTO sessions (
        session_key, source_session_id, provider, file_path, project_path,
        original_title, started_at, updated_at, message_count,
        file_mtime_ms, file_size, parser_version, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        source_session_id=excluded.source_session_id,
        provider=excluded.provider,
        file_path=excluded.file_path,
        project_path=excluded.project_path,
        original_title=excluded.original_title,
        started_at=excluded.started_at,
        updated_at=excluded.updated_at,
        message_count=excluded.message_count,
        file_mtime_ms=excluded.file_mtime_ms,
        file_size=excluded.file_size,
        parser_version=excluded.parser_version,
        indexed_at=excluded.indexed_at
    `);
    const deleteFts = this.#db.prepare("DELETE FROM messages_fts WHERE session_key = ?");
    const insertFts = this.#db.prepare(`
      INSERT INTO messages_fts (
        session_key, provider, project_path, role, timestamp, message_index, content
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const customTitle = this.#db.prepare(
      "SELECT custom_title FROM session_metadata WHERE session_key = ?",
    );
    const deleteSession = this.#db.prepare("DELETE FROM sessions WHERE session_key = ?");
    const existingRows = options.visibleFiles === null
      ? []
      : this.#db
          .prepare("SELECT session_key, file_path FROM sessions WHERE provider = ?")
          .all(options.provider) as SqlRow[];
    const upsertSessionKeys = new Set([
      ...options.upserts.map((entry) => entry.session.sessionKey),
      ...(options.retainSessionKeys ?? []),
    ]);
    const missingSessionKeys = new Set(existingRows.flatMap((row) => {
      const sessionKey = stringColumn(row, "session_key");
      return options.visibleFiles?.has(stringColumn(row, "file_path")) === false &&
        !upsertSessionKeys.has(sessionKey)
        ? [sessionKey]
        : [];
    }));
    const deleteSessionKeys = new Set([...options.removeSessionKeys, ...missingSessionKeys]);
    const errors: Array<{ path: string; error: string }> = [];
    let indexed = 0;
    const indexedAt = Date.now();

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const sessionKey of deleteSessionKeys) {
        deleteSession.run(sessionKey);
        deleteFts.run(sessionKey);
      }
      for (const { session, file, parserVersion } of options.upserts) {
        this.#db.exec("SAVEPOINT session_upsert");
        try {
          insertSession.run(
            session.sessionKey,
            session.sourceSessionId,
            session.provider,
            session.filePath,
            session.projectPath,
            session.originalTitle,
            session.startedAt,
            session.updatedAt,
            session.messages.length,
            Math.trunc(file.mtimeMs),
            file.size,
            parserVersion,
            indexedAt,
          );
          deleteFts.run(session.sessionKey);
          for (const message of session.messages) {
            insertFts.run(
              session.sessionKey,
              session.provider,
              session.projectPath,
              message.role,
              message.timestamp,
              message.index,
              message.content,
            );
          }
          const metadata = customTitle.get(session.sessionKey) as SqlRow | undefined;
          const savedTitle = nullableStringColumn(metadata ?? {}, "custom_title");
          insertFts.run(
            session.sessionKey,
            session.provider,
            session.projectPath,
            "title",
            session.updatedAt,
            -1,
            savedTitle === null ? session.originalTitle : `${savedTitle}\n${session.originalTitle}`,
          );
          this.#db.exec("RELEASE SAVEPOINT session_upsert");
          indexed += 1;
        } catch (error) {
          this.#db.exec("ROLLBACK TO SAVEPOINT session_upsert");
          this.#db.exec("RELEASE SAVEPOINT session_upsert");
          errors.push({ path: file.path, error: String(error) });
        }
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return { indexed, removed: missingSessionKeys.size, errors };
  }

  #insertTitleFts(statement: ReturnType<DatabaseSync["prepare"]>, sessionKey: string): void {
    const row = this.#db
      .prepare(`
        SELECT s.provider, s.project_path, s.updated_at, s.original_title, m.custom_title
        FROM sessions s
        LEFT JOIN session_metadata m ON m.session_key = s.session_key
        WHERE s.session_key = ?
      `)
      .get(sessionKey) as SqlRow | undefined;
    if (row === undefined) return;
    const originalTitle = stringColumn(row, "original_title");
    const customTitle = nullableStringColumn(row, "custom_title");
    const content = customTitle === null ? originalTitle : `${customTitle}\n${originalTitle}`;
    statement.run(
      sessionKey,
      stringColumn(row, "provider"),
      nullableStringColumn(row, "project_path"),
      "title",
      stringColumn(row, "updated_at"),
      -1,
      content,
    );
  }

  removeMissingFiles(provider: ProviderId, visibleFiles: ReadonlySet<string>): number {
    const rows = this.#db
      .prepare("SELECT session_key, file_path FROM sessions WHERE provider = ?")
      .all(provider) as SqlRow[];
    const removeSession = this.#db.prepare("DELETE FROM sessions WHERE session_key = ?");
    const removeFts = this.#db.prepare("DELETE FROM messages_fts WHERE session_key = ?");
    let removed = 0;

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        if (visibleFiles.has(stringColumn(row, "file_path"))) continue;
        const sessionKey = stringColumn(row, "session_key");
        removeSession.run(sessionKey);
        removeFts.run(sessionKey);
        removed += 1;
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return removed;
  }

  search(options: {
    query: string;
    provider?: ProviderId;
    projectPath?: string;
    favoritesOnly?: boolean;
    renamedOnly?: boolean;
    collectionId?: number | null;
    limit?: number;
  }): SearchResult[] {
    const query = options.query.trim();
    const terms = parseSearchTerms(query);
    if (terms.length === 0) return [];
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const filters: string[] = [];
    const filterValues: SqlValue[] = [];
    if (options.provider !== undefined) {
      filters.push("s.provider = ?");
      filterValues.push(options.provider);
    }
    if (options.projectPath !== undefined && options.projectPath !== "") {
      filters.push("s.project_path = ?");
      filterValues.push(options.projectPath);
    }
    if (options.favoritesOnly === true) filters.push("COALESCE(m.favorite, 0) = 1");
    if (options.renamedOnly === true) {
      filters.push("m.custom_title IS NOT NULL AND TRIM(m.custom_title) != ''");
    }
    if (options.collectionId === null) filters.push("m.collection_id IS NULL");
    else if (options.collectionId !== undefined) {
      filters.push("m.collection_id = ?");
      filterValues.push(options.collectionId);
    }
    const extraWhere = filters.length === 0 ? "" : ` AND ${filters.join(" AND ")}`;

    const searchColumns = `
      f.session_key, s.source_session_id, s.provider, s.project_path,
      s.original_title, m.custom_title, COALESCE(m.favorite, 0) favorite, m.collection_id,
      s.started_at, s.updated_at, s.message_count,
      CAST(f.message_index AS INTEGER) message_index,
      f.role, f.content, f.rank
    `;
    const searchFrom = `
      FROM messages_fts f
      JOIN sessions s ON s.session_key = f.session_key
      LEFT JOIN session_metadata m ON m.session_key = f.session_key
    `;
    const select = `SELECT ${searchColumns} ${searchFrom}`;
    const idSelect = `
      SELECT s.session_key, s.source_session_id, s.provider, s.project_path,
             s.original_title, m.custom_title, COALESCE(m.favorite, 0) favorite, m.collection_id,
             s.started_at, s.updated_at, s.message_count,
             -1 message_index, 'title' role, s.source_session_id content, -1000000 rank
      FROM sessions s
      LEFT JOIN session_metadata m ON m.session_key = s.session_key
    `;
    const matches = new Map<string, SessionSearchMatch>();
    let candidateSessionKeys: Set<string> | null = null;
    const orderedTerms = terms
      .map((term, index) => ({ term, index }))
      .sort((left, right) => {
        const indexedDifference = Number(right.term.length >= 3) - Number(left.term.length >= 3);
        return indexedDifference !== 0 ? indexedDifference : right.term.length - left.term.length;
      });

    for (const { term, index: termIndex } of orderedTerms) {
      const previousCandidates: Set<string> | null = candidateSessionKeys;
      if (previousCandidates?.size === 0) return [];
      const restrictCandidates = previousCandidates !== null && previousCandidates.size <= 500;
      const candidateValues = restrictCandidates ? [...previousCandidates] : [];
      const candidateWhere = restrictCandidates
        ? ` AND s.session_key IN (${candidateValues.map(() => "?").join(", ")})`
        : "";
      const scopedWhere = `${extraWhere}${candidateWhere}`;
      const scopedValues = [...filterValues, ...candidateValues];
      const idLikeQuery = escapeLikeQuery(term);
      const singleTermIdSuffix = terms.length === 1
        ? ` ORDER BY CASE
                       WHEN s.source_session_id = ? COLLATE NOCASE THEN 0
                       WHEN s.session_key = ? COLLATE NOCASE THEN 1
                       ELSE 2
                     END,
                     COALESCE(m.favorite, 0) DESC, s.updated_at DESC
            LIMIT ?`
        : "";
      const singleTermIdValues = terms.length === 1 ? [term, term, limit] : [];
      const idRows = this.#db
        .prepare(
          `${idSelect}
           WHERE (s.source_session_id LIKE ? ESCAPE '\\' COLLATE NOCASE
                  OR s.session_key LIKE ? ESCAPE '\\' COLLATE NOCASE)${scopedWhere}${singleTermIdSuffix}`,
        )
        .all(idLikeQuery, idLikeQuery, ...scopedValues, ...singleTermIdValues) as SqlRow[];
      const contentPredicate = term.length < 3
        ? "f.content LIKE ? ESCAPE '\\'"
        : "messages_fts MATCH ?";
      const contentQueryValue = term.length < 3 ? escapeLikeQuery(term) : escapeFtsQuery(term);
      const contentRows = terms.length === 1
        ? (this.#db
            .prepare(
              `${select} WHERE ${contentPredicate}${scopedWhere}
               ORDER BY (f.rank * CASE f.role WHEN 'title' THEN 1.5 WHEN 'user' THEN 1.15 ELSE 1 END),
                        s.updated_at DESC LIMIT ?`,
            )
            .all(contentQueryValue, ...scopedValues, limit) as SqlRow[])
        : (this.#db
            .prepare(
              `SELECT * FROM (
                 SELECT ${searchColumns},
                        ROW_NUMBER() OVER (
                          PARTITION BY f.session_key
                          ORDER BY (f.rank * CASE f.role
                            WHEN 'title' THEN 1.5 WHEN 'user' THEN 1.15 ELSE 1 END),
                            CAST(f.message_index AS INTEGER)
                        ) search_row_number
                 ${searchFrom}
                 WHERE ${contentPredicate}${scopedWhere}
               ) WHERE search_row_number = 1`,
            )
            .all(contentQueryValue, ...scopedValues) as SqlRow[]);
      const termSessionKeys = new Set<string>();

      for (const row of [...idRows, ...contentRows]) {
        const sessionKey = stringColumn(row, "session_key");
        termSessionKeys.add(sessionKey);
        let sessionMatch = matches.get(sessionKey);
        if (sessionMatch === undefined) {
          sessionMatch = { terms: new Set(), rows: new Map() };
          matches.set(sessionKey, sessionMatch);
        }
        sessionMatch.terms.add(termIndex);
        const rowKey = searchRowKey(row);
        const rowMatch = sessionMatch.rows.get(rowKey) ?? { row, terms: new Set<number>() };
        rowMatch.terms.add(termIndex);
        sessionMatch.rows.set(rowKey, rowMatch);
      }

      candidateSessionKeys = previousCandidates === null
        ? termSessionKeys
        : new Set([...previousCandidates].filter((sessionKey) => termSessionKeys.has(sessionKey)));
    }

    const rankedMatches = [...matches.entries()]
      .filter(([sessionKey, match]) =>
        candidateSessionKeys?.has(sessionKey) === true && match.terms.size === terms.length)
      .map(([, match]) => {
        const bestRow = [...match.rows.values()].sort(compareSearchRows)[0];
        if (bestRow === undefined) throw new Error("Search match has no indexed rows");
        return { bestRow, summary: toSessionSummary(bestRow.row) };
      })
      .sort((left, right) => {
        const termDifference = right.bestRow.terms.size - left.bestRow.terms.size;
        if (termDifference !== 0) return termDifference;
        const favoriteDifference = Number(right.summary.favorite) - Number(left.summary.favorite);
        if (favoriteDifference !== 0) return favoriteDifference;
        const rankDifference =
          numberColumn(left.bestRow.row, "rank") - numberColumn(right.bestRow.row, "rank");
        if (rankDifference !== 0) return rankDifference;
        return right.summary.updatedAt.localeCompare(left.summary.updatedAt);
      })
      .slice(0, limit);

    return rankedMatches.map(({ bestRow, summary }) => {
      const row = bestRow.row;
      const content = stringColumn(row, "content");
      const matchIndex = firstSearchTermIndex(content, terms);
      const start = Math.max(0, matchIndex < 0 ? 0 : matchIndex - 60);
      const end = Math.min(content.length, start + 220);
      const rawRole = stringColumn(row, "role");
      const role = rawRole === "title" ? "title" : rawRole === "assistant" ? "assistant" : "user";
      return {
        ...summary,
        messageIndex: numberColumn(row, "message_index"),
        role,
        snippet: `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`,
        score: bestRow.terms.size * 1_000_000 - numberColumn(row, "rank"),
      };
    });
  }

  listSessions(options?: {
    provider?: ProviderId;
    projectPath?: string;
    favoritesOnly?: boolean;
    renamedOnly?: boolean;
    collectionId?: number | null;
    limit?: number;
  }): SessionSummary[] {
    const filters: string[] = [];
    const values: SqlValue[] = [];
    if (options?.provider !== undefined) {
      filters.push("s.provider = ?");
      values.push(options.provider);
    }
    if (options?.projectPath !== undefined && options.projectPath !== "") {
      filters.push("s.project_path = ?");
      values.push(options.projectPath);
    }
    if (options?.favoritesOnly === true) filters.push("COALESCE(m.favorite, 0) = 1");
    if (options?.renamedOnly === true) {
      filters.push("m.custom_title IS NOT NULL AND TRIM(m.custom_title) != ''");
    }
    if (options?.collectionId === null) filters.push("m.collection_id IS NULL");
    else if (options?.collectionId !== undefined) {
      filters.push("m.collection_id = ?");
      values.push(options.collectionId);
    }
    const where = filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`;
    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
    const rows = this.#db
      .prepare(`
        SELECT s.*, m.custom_title, COALESCE(m.favorite, 0) favorite, m.collection_id
        FROM sessions s
        LEFT JOIN session_metadata m ON m.session_key = s.session_key
        ${where}
        ORDER BY COALESCE(m.favorite, 0) DESC, s.updated_at DESC
        LIMIT ?
      `)
      .all(...values, limit) as SqlRow[];
    return rows.map(toSessionSummary);
  }

  getSession(sessionKey: string): { session: SessionSummary; messages: NormalizedMessage[] } | null {
    const sessionRow = this.#db
      .prepare(`
        SELECT s.*, m.custom_title, COALESCE(m.favorite, 0) favorite, m.collection_id
        FROM sessions s
        LEFT JOIN session_metadata m ON m.session_key = s.session_key
        WHERE s.session_key = ?
      `)
      .get(sessionKey) as SqlRow | undefined;
    if (sessionRow === undefined) return null;
    const messageRows = this.#db
      .prepare(`
        SELECT role, content, timestamp, CAST(message_index AS INTEGER) message_index
        FROM messages_fts
        WHERE session_key = ? AND role IN ('user', 'assistant')
        ORDER BY CAST(message_index AS INTEGER)
      `)
      .all(sessionKey) as SqlRow[];
    return {
      session: toSessionSummary(sessionRow),
      messages: messageRows.map((row) => ({
        index: numberColumn(row, "message_index"),
        role: stringColumn(row, "role") === "assistant" ? "assistant" : "user",
        content: stringColumn(row, "content"),
        timestamp: stringColumn(row, "timestamp"),
      })),
    };
  }

  createContextSnippet(input: {
    title: string;
    content: string;
    favorite?: boolean;
    collectionId?: number | null;
  }): ContextSnippetDetail {
    const title = input.title.replace(/\s+/g, " ").trim();
    if (title === "" || title.length > 200) {
      throw new Error("Context title must contain 1 to 200 characters");
    }
    if (input.content.trim() === "" || input.content.length > 1_000_000) {
      throw new Error("Context content must contain 1 to 1000000 characters");
    }
    const collectionId = input.collectionId ?? null;
    if (collectionId !== null) this.#assertCollectionExists(collectionId);
    const now = Date.now();

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#db.prepare(`
        INSERT INTO context_snippets(
          title, content, favorite, collection_id, copy_count,
          last_copied_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, NULL, ?, ?)
      `).run(title, input.content, input.favorite === true ? 1 : 0, collectionId, now, now);
      const id = Number(result.lastInsertRowid);
      this.#db.prepare(`
        INSERT INTO context_snippets_fts(snippet_id, title, content) VALUES (?, ?, ?)
      `).run(id, title, input.content);
      this.#db.exec("COMMIT");
      const created = this.getContextSnippet(id);
      if (created === null) throw new Error("Created context snippet could not be loaded");
      return created;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  listContextSnippets(options?: {
    query?: string;
    favoritesOnly?: boolean;
    collectionId?: number | null;
    sort?: ContextSnippetSort;
    limit?: number;
  }): ContextSnippetSummary[] {
    const query = options?.query?.trim() ?? "";
    const filters: string[] = [];
    const values: SqlValue[] = [];
    if (options?.favoritesOnly === true) filters.push("c.favorite = 1");
    if (options?.collectionId === null) filters.push("c.collection_id IS NULL");
    else if (options?.collectionId !== undefined) {
      filters.push("c.collection_id = ?");
      values.push(options.collectionId);
    }

    let rows: SqlRow[];
    if (query === "") {
      const where = filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`;
      rows = this.#db.prepare(`
        SELECT c.*, 0 fts_rank FROM context_snippets c ${where}
      `).all(...values) as SqlRow[];
    } else if (query.length < 3) {
      filters.unshift("(c.title LIKE ? ESCAPE '\\' OR c.content LIKE ? ESCAPE '\\')");
      const like = escapeLikeQuery(query);
      values.unshift(like, like);
      rows = this.#db.prepare(`
        SELECT c.*, 0 fts_rank
        FROM context_snippets c
        WHERE ${filters.join(" AND ")}
      `).all(...values) as SqlRow[];
    } else {
      filters.unshift("context_snippets_fts MATCH ?");
      values.unshift(escapeFtsQuery(query));
      rows = this.#db.prepare(`
        SELECT c.*, bm25(context_snippets_fts, 0.0, 5.0, 1.0) fts_rank
        FROM context_snippets_fts
        JOIN context_snippets c ON c.id = CAST(context_snippets_fts.snippet_id AS INTEGER)
        WHERE ${filters.join(" AND ")}
      `).all(...values) as SqlRow[];
    }

    const details = rows.map((row) => ({
      detail: toContextSnippetDetail(row, query),
      ftsRank: Number(row.fts_rank ?? 0),
    }));
    const sort = options?.sort ?? "smart";
    const now = Date.now();
    details.sort((leftEntry, rightEntry) => {
      const left = leftEntry.detail;
      const right = rightEntry.detail;
      if (query !== "") {
        const normalizedQuery = query.toLocaleLowerCase();
        const leftTitle = left.title.toLocaleLowerCase();
        const rightTitle = right.title.toLocaleLowerCase();
        const exactDifference = Number(rightTitle === normalizedQuery) - Number(leftTitle === normalizedQuery);
        if (exactDifference !== 0) return exactDifference;
        const titleDifference = Number(rightTitle.includes(normalizedQuery)) - Number(leftTitle.includes(normalizedQuery));
        if (titleDifference !== 0) return titleDifference;
        const relevanceDifference = leftEntry.ftsRank - rightEntry.ftsRank;
        if (relevanceDifference !== 0) return relevanceDifference;
      }
      const favoriteDifference = Number(right.favorite) - Number(left.favorite);
      if (favoriteDifference !== 0) return favoriteDifference;
      if (sort === "created-desc") return right.createdAt - left.createdAt || right.id - left.id;
      if (sort === "updated-desc") return right.updatedAt - left.updatedAt || right.id - left.id;
      if (sort === "last-copied-desc") {
        return compareNullableTimeDesc(left.lastCopiedAt, right.lastCopiedAt) || right.id - left.id;
      }
      if (sort === "copies-desc") {
        return right.copyCount - left.copyCount || right.updatedAt - left.updatedAt || right.id - left.id;
      }
      return contextSmartScore(right, now) - contextSmartScore(left, now) || right.updatedAt - left.updatedAt || right.id - left.id;
    });
    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
    return details.slice(0, limit).map(({ detail }) => {
      const { content: _content, ...summary } = detail;
      return summary;
    });
  }

  getContextSnippet(id: number): ContextSnippetDetail | null {
    const row = this.#db.prepare("SELECT * FROM context_snippets WHERE id = ?").get(id) as SqlRow | undefined;
    return row === undefined ? null : toContextSnippetDetail(row);
  }

  updateContextSnippet(
    id: number,
    patch: { title?: string; content?: string; favorite?: boolean; collectionId?: number | null },
  ): ContextSnippetDetail | null {
    const current = this.getContextSnippet(id);
    if (current === null) return null;
    const title = patch.title === undefined ? current.title : patch.title.replace(/\s+/g, " ").trim();
    const content = patch.content === undefined ? current.content : patch.content;
    if (title === "" || title.length > 200) {
      throw new Error("Context title must contain 1 to 200 characters");
    }
    if (content.trim() === "" || content.length > 1_000_000) {
      throw new Error("Context content must contain 1 to 1000000 characters");
    }
    const collectionId = patch.collectionId === undefined ? current.collectionId : patch.collectionId;
    if (collectionId !== null) this.#assertCollectionExists(collectionId);
    const favorite = patch.favorite ?? current.favorite;
    const now = Date.now();

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`
        UPDATE context_snippets
        SET title = ?, content = ?, favorite = ?, collection_id = ?, updated_at = ?
        WHERE id = ?
      `).run(title, content, favorite ? 1 : 0, collectionId, now, id);
      this.#db.prepare("DELETE FROM context_snippets_fts WHERE snippet_id = ?").run(id);
      this.#db.prepare(`
        INSERT INTO context_snippets_fts(snippet_id, title, content) VALUES (?, ?, ?)
      `).run(id, title, content);
      this.#db.exec("COMMIT");
      return this.getContextSnippet(id);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteContextSnippet(id: number): boolean {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("DELETE FROM context_snippets_fts WHERE snippet_id = ?").run(id);
      const result = this.#db.prepare("DELETE FROM context_snippets WHERE id = ?").run(id);
      this.#db.exec("COMMIT");
      return result.changes > 0;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  recordContextSnippetCopy(id: number): ContextSnippetDetail | null {
    const result = this.#db.prepare(`
      UPDATE context_snippets
      SET copy_count = copy_count + 1, last_copied_at = ?
      WHERE id = ?
    `).run(Date.now(), id);
    return result.changes === 0 ? null : this.getContextSnippet(id);
  }

  #assertCollectionExists(id: number): void {
    const collectionExists = this.#db.prepare("SELECT 1 present FROM collections WHERE id = ?").get(id);
    if (collectionExists === undefined) throw new Error("Collection not found");
  }

  updateMetadata(
    sessionKey: string,
    patch: { customTitle?: string | null; favorite?: boolean; collectionId?: number | null },
  ): SessionSummary | null {
    const sessionExists = this.#db
      .prepare("SELECT 1 present FROM sessions WHERE session_key = ?")
      .get(sessionKey);
    if (sessionExists === undefined) return null;
    const current = this.#db
      .prepare(
        "SELECT custom_title, favorite, collection_id FROM session_metadata WHERE session_key = ?",
      )
      .get(sessionKey) as SqlRow | undefined;
    const customTitle =
      patch.customTitle === undefined
        ? nullableStringColumn(current ?? {}, "custom_title")
        : patch.customTitle?.trim() || null;
    const favorite =
      patch.favorite === undefined
        ? numberColumn(current ?? {}, "favorite") === 1
        : patch.favorite;
    const collectionId =
      patch.collectionId === undefined
        ? current?.collection_id === null || current?.collection_id === undefined
          ? null
          : numberColumn(current, "collection_id")
        : patch.collectionId;
    if (collectionId !== null) {
      const collectionExists = this.#db
        .prepare("SELECT 1 present FROM collections WHERE id = ?")
        .get(collectionId);
      if (collectionExists === undefined) throw new Error("Collection not found");
    }
    this.#db
      .prepare(`
        INSERT INTO session_metadata(session_key, custom_title, favorite, collection_id, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_key) DO UPDATE SET
          custom_title=excluded.custom_title,
          favorite=excluded.favorite,
          collection_id=excluded.collection_id,
          updated_at=excluded.updated_at
      `)
      .run(sessionKey, customTitle, favorite ? 1 : 0, collectionId, Date.now());

    this.#db.prepare("DELETE FROM messages_fts WHERE session_key = ? AND role = 'title'").run(sessionKey);
    const insertFts = this.#db.prepare(`
      INSERT INTO messages_fts (
        session_key, provider, project_path, role, timestamp, message_index, content
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.#insertTitleFts(insertFts, sessionKey);
    return this.getSession(sessionKey)?.session ?? null;
  }

  createCollection(name: string): CollectionSummary {
    const normalized = name.replace(/\s+/g, " ").trim();
    if (normalized === "" || normalized.length > 100) {
      throw new Error("Collection name must contain 1 to 100 characters");
    }
    const now = Date.now();
    const result = this.#db
      .prepare("INSERT INTO collections(name, created_at, updated_at) VALUES (?, ?, ?)")
      .run(normalized, now, now);
    return {
      id: Number(result.lastInsertRowid),
      name: normalized,
      sessionCount: 0,
      contextCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  listCollections(): CollectionSummary[] {
    const rows = this.#db
      .prepare(`
        SELECT c.id, c.name, c.created_at, c.updated_at,
               (SELECT COUNT(*)
                FROM session_metadata m
                JOIN sessions s ON s.session_key = m.session_key
                WHERE m.collection_id = c.id) session_count,
               (SELECT COUNT(*)
                FROM context_snippets n
                WHERE n.collection_id = c.id) context_count
        FROM collections c
        ORDER BY c.name COLLATE NOCASE
      `)
      .all() as SqlRow[];
    return rows.map((row) => ({
      id: numberColumn(row, "id"),
      name: stringColumn(row, "name"),
      sessionCount: numberColumn(row, "session_count"),
      contextCount: numberColumn(row, "context_count"),
      createdAt: numberColumn(row, "created_at"),
      updatedAt: numberColumn(row, "updated_at"),
    }));
  }

  renameCollection(id: number, name: string): CollectionSummary | null {
    const normalized = name.replace(/\s+/g, " ").trim();
    if (normalized === "" || normalized.length > 100) {
      throw new Error("Collection name must contain 1 to 100 characters");
    }
    const result = this.#db
      .prepare("UPDATE collections SET name = ?, updated_at = ? WHERE id = ?")
      .run(normalized, Date.now(), id);
    if (result.changes === 0) return null;
    return this.listCollections().find((collection) => collection.id === id) ?? null;
  }

  deleteCollection(id: number): boolean {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare("UPDATE session_metadata SET collection_id = NULL, updated_at = ? WHERE collection_id = ?")
        .run(Date.now(), id);
      this.#db
        .prepare("UPDATE context_snippets SET collection_id = NULL, updated_at = ? WHERE collection_id = ?")
        .run(Date.now(), id);
      const result = this.#db.prepare("DELETE FROM collections WHERE id = ?").run(id);
      this.#db.exec("COMMIT");
      return result.changes > 0;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getProviderSourceSettings(
    defaultHomes: Record<ProviderId, string>,
    defaultProviders: ReadonlySet<ProviderId>,
  ): Array<Pick<ProviderSourceSetting, "provider" | "enabled" | "home" | "defaultHome" | "customized">> {
    const rows = this.#db
      .prepare("SELECT key, value FROM app_settings WHERE key LIKE 'provider_source.%'")
      .all() as SqlRow[];
    const values = new Map(rows.map((row) => [stringColumn(row, "key"), stringColumn(row, "value")]));
    return PROVIDER_IDS.map((provider) => {
      const defaultHome = defaultHomes[provider];
      const storedHome = values.get(`provider_source.${provider}.home`)?.trim();
      const customized = storedHome !== undefined && isAbsolute(storedHome);
      const storedEnabled = values.get(`provider_source.${provider}.enabled`);
      return {
        provider,
        enabled: storedEnabled === undefined ? defaultProviders.has(provider) : storedEnabled === "1",
        home: customized ? storedHome : defaultHome,
        defaultHome,
        customized,
      };
    });
  }

  updateProviderSourceSetting(
    provider: ProviderId,
    setting: { enabled: boolean; home: string | null },
  ): void {
    const home = setting.home?.trim() || null;
    if (home !== null && (!isAbsolute(home) || home.length > 2000)) {
      throw new Error("Provider home must be an absolute path no longer than 2000 characters");
    }
    const update = this.#db.prepare(`
      INSERT INTO app_settings(key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      update.run(`provider_source.${provider}.enabled`, setting.enabled ? "1" : "0", Date.now());
      if (home === null) {
        this.#db.prepare("DELETE FROM app_settings WHERE key = ?").run(`provider_source.${provider}.home`);
      } else {
        update.run(`provider_source.${provider}.home`, home, Date.now());
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getResumeCommandTemplates(): ResumeCommandTemplates {
    const templates = { ...DEFAULT_RESUME_COMMAND_TEMPLATES };
    const rows = this.#db
      .prepare("SELECT key, value FROM app_settings WHERE key LIKE 'resume_command_template.%'")
      .all() as SqlRow[];
    for (const row of rows) {
      const provider = stringColumn(row, "key").replace("resume_command_template.", "");
      if (isProviderId(provider)) {
        templates[provider] = stringColumn(row, "value");
      }
    }
    return templates;
  }

  updateResumeCommandTemplate(
    provider: ProviderId,
    template: string,
  ): ResumeCommandTemplates {
    const normalized = template.trim();
    if (normalized === "" || normalized.length > 500) {
      throw new Error("Resume command template must contain 1 to 500 characters");
    }
    this.#db
      .prepare(`
        INSERT INTO app_settings(key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
      `)
      .run(`resume_command_template.${provider}`, normalized, Date.now());
    return this.getResumeCommandTemplates();
  }

  getTerminalSettings(runtimePlatform: NodeJS.Platform = process.platform): TerminalSettings {
    const platform = normalizeRuntimePlatform(runtimePlatform);
    const defaults = defaultTerminalSettings(platform);
    const availableTerminals = terminalIdsForPlatform(platform);
    const rows = this.#db
      .prepare("SELECT key, value FROM app_settings WHERE key IN ('terminal.kind', 'terminal.custom_path', 'terminal.shell_path')")
      .all() as SqlRow[];
    const values = new Map(rows.map((row) => [stringColumn(row, "key"), stringColumn(row, "value")]));
    const storedTerminal = values.get("terminal.kind");
    const terminal = availableTerminals.includes(storedTerminal as TerminalSettings["terminal"])
      ? (storedTerminal as TerminalSettings["terminal"])
      : defaults.terminal;
    const customPath = values.get("terminal.custom_path")?.trim() || null;
    const environmentShell = process.env.SHELL?.trim();
    const defaultShellPath = platform === "win32"
      ? defaults.shellPath
      : environmentShell !== undefined && isAbsolute(environmentShell)
        ? environmentShell
        : defaults.shellPath;
    const storedShellPath = values.get("terminal.shell_path")?.trim();
    const shellPath = storedShellPath !== undefined && isValidShellReference(storedShellPath, platform)
      ? storedShellPath
      : defaultShellPath;
    return { terminal, customPath, shellPath };
  }

  updateTerminalSettings(
    settings: TerminalSettings,
    runtimePlatform: NodeJS.Platform = process.platform,
  ): TerminalSettings {
    const platform = normalizeRuntimePlatform(runtimePlatform);
    if (!TERMINAL_IDS.includes(settings.terminal) || !terminalIdsForPlatform(platform).includes(settings.terminal)) {
      throw new Error("Unsupported terminal on this platform");
    }
    const customPath = settings.customPath?.trim() || null;
    const shellPath = settings.shellPath.trim();
    if (customPath !== null && customPath.length > 1000) {
      throw new Error("Custom terminal path must not exceed 1000 characters");
    }
    if (settings.terminal === "custom" && customPath === null) {
      throw new Error("Custom terminal path is required");
    }
    if (!isValidShellReference(shellPath, platform) || shellPath.length > 1000) {
      throw new Error("Invalid shell executable");
    }
    const update = this.#db.prepare(`
      INSERT INTO app_settings(key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `);
    const now = Date.now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      update.run("terminal.kind", settings.terminal, now);
      update.run("terminal.custom_path", customPath ?? "", now);
      update.run("terminal.shell_path", shellPath, now);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return { terminal: settings.terminal, customPath, shellPath };
  }

  listProjects(): Array<{ provider: ProviderId; projectPath: string; count: number }> {
    const rows = this.#db
      .prepare(`
        SELECT provider, project_path, COUNT(*) count
        FROM sessions
        WHERE project_path IS NOT NULL AND project_path != ''
        GROUP BY provider, project_path
        ORDER BY project_path
      `)
      .all() as SqlRow[];
    return rows.map((row) => ({
      provider: providerColumn(row),
      projectPath: stringColumn(row, "project_path"),
      count: numberColumn(row, "count"),
    }));
  }

  countSessions(): Record<ProviderId, number> {
    const result = Object.fromEntries(PROVIDER_IDS.map((provider) => [provider, 0])) as Record<ProviderId, number>;
    const rows = this.#db
      .prepare("SELECT provider, COUNT(*) count FROM sessions GROUP BY provider")
      .all() as SqlRow[];
    for (const row of rows) result[providerColumn(row)] = numberColumn(row, "count");
    return result;
  }
}
