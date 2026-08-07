import { useLingui } from "@lingui/react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type {
  CollectionSummary,
  NormalizedMessage,
  ProviderDescriptor,
  ProviderId,
  ProviderSourceSetting,
  ProviderStatus,
  ResumeCommandTemplates,
  RuntimePlatform,
  SearchResult,
  SessionSummary,
  SyncProgress,
  TerminalId,
  TerminalSettings,
} from "../shared/types.ts";
import { PROVIDER_DESCRIPTORS, providerDescriptor } from "../shared/providers.ts";
import {
  DEFAULT_RESUME_COMMAND_TEMPLATES,
  renderResumeCommand,
} from "../shared/resumeCommand.ts";
import type { Translator } from "./i18n/index.ts";
import { IndexingStatus } from "./components/IndexingStatus.tsx";
import {
  ProviderSourcesDialog,
  type ProviderSourceDraft,
} from "./components/ProviderSourcesDialog.tsx";
import { SearchBox } from "./components/SearchBox.tsx";
import { UpdateNotification } from "./components/UpdateNotification.tsx";
import { ProjectFilter } from "./components/ProjectFilter.tsx";
import { ProviderFilter } from "./components/ProviderFilter.tsx";
import { SelectControl } from "./components/SelectControl.tsx";
import { HighlightedText } from "./components/HighlightedText.tsx";
import { AppViewTabs, type AppView } from "./components/AppViewTabs.tsx";
import { ContextLibrary } from "./components/ContextLibrary.tsx";
import { ConversationNavigation } from "./components/ConversationNavigation.tsx";
import {
  commandDialectForTerminal,
  defaultTerminalSettings,
  terminalIdsForPlatform,
} from "../shared/terminal.ts";
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  parseStoredSidebarWidth,
  SIDEBAR_STORAGE_KEY,
} from "./sidebarWidth.ts";
import { useAppKeyboardShortcuts, useDialogFocus } from "./useAppKeyboardShortcuts.ts";
import { jsonRequest, queryString } from "./api.ts";
import { copyText } from "./clipboard.ts";
import { nextHighlightIndex } from "./conversationNavigation.ts";

type Project = { provider: ProviderId; projectPath: string; count: number };
type SessionDetail = { session: SessionSummary; messages: NormalizedMessage[] };
type AppStatus = {
  providers: ProviderStatus[];
  counts: Record<ProviderId, number>;
  sync: SyncProgress;
  runtimePlatform: RuntimePlatform;
};
type ActiveSearchMatch = {
  sessionKey: string;
  query: string;
};

const INDEX_STATUS_POLL_MS = 1500;

const DEFAULT_TERMINAL_SETTINGS = defaultTerminalSettings("darwin");

const initialSidebarWidth = (): number => {
  try {
    const stored = parseStoredSidebarWidth(window.localStorage.getItem(SIDEBAR_STORAGE_KEY));
    return clampSidebarWidth(stored ?? DEFAULT_SIDEBAR_WIDTH, window.innerWidth);
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
};

const providerLabel = (provider: ProviderId): string => providerDescriptor(provider).label;
const providerColor = (provider: ProviderId): string => providerDescriptor(provider).color;

const isSearchResult = (item: SessionSummary | SearchResult): item is SearchResult =>
  "messageIndex" in item;

const formatDate = (value: string, locale: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(locale);
};

export const App = () => {
  const { i18n } = useLingui();
  const t: Translator = (id, values) => i18n._(id, values);
  const locale = i18n.locale || "en";
  const [appView, setAppView] = useState<AppView>("sessions");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [provider, setProvider] = useState<ProviderId | "all">("all");
  const [providerDescriptors, setProviderDescriptors] = useState<ProviderDescriptor[]>(PROVIDER_DESCRIPTORS);
  const [projectPath, setProjectPath] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [renamedOnly, setRenamedOnly] = useState(false);
  const [collectionFilter, setCollectionFilter] = useState("all");
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [collectionEditor, setCollectionEditor] = useState<"create" | "rename" | null>(null);
  const [collectionNameDraft, setCollectionNameDraft] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [selected, setSelected] = useState<SessionDetail | null>(null);
  const [selectedMessageIndex, setSelectedMessageIndex] = useState<number | null>(null);
  const [activeSearchMatch, setActiveSearchMatch] = useState<ActiveSearchMatch | null>(null);
  const [highlightNavigation, setHighlightNavigation] = useState({
    currentIndex: -1,
    total: 0,
  });
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [resumeCommandTemplates, setResumeCommandTemplates] =
    useState<ResumeCommandTemplates>(DEFAULT_RESUME_COMMAND_TEMPLATES);
  const [editingResumeCommand, setEditingResumeCommand] = useState(false);
  const [resumeCommandDraft, setResumeCommandDraft] = useState("");
  const [terminalSettings, setTerminalSettings] = useState<TerminalSettings>(DEFAULT_TERMINAL_SETTINGS);
  const [terminalDraft, setTerminalDraft] = useState<TerminalId>("terminal");
  const [customTerminalPathDraft, setCustomTerminalPathDraft] = useState("");
  const [shellPathDraft, setShellPathDraft] = useState("/bin/zsh");
  const [providerSourceSettings, setProviderSourceSettings] = useState<ProviderSourceSetting[]>([]);
  const [providerSourceDrafts, setProviderSourceDrafts] = useState<Partial<Record<ProviderId, ProviderSourceDraft>>>({});
  const [showProviderSources, setShowProviderSources] = useState(false);
  const [savingProviderSource, setSavingProviderSource] = useState<ProviderId | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const appShellRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const providerSourcesTriggerRef = useRef<HTMLButtonElement>(null);
  const providerSourcesCloseRef = useRef<HTMLButtonElement>(null);
  const providerSourcesWasOpenRef = useRef(false);
  const sidebarWidthRef = useRef(sidebarWidth);
  const resizingSidebarRef = useRef(false);
  const messageRefs = useRef(new Map<number, HTMLElement>());
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const runtimePlatform = status?.runtimePlatform ?? "other";
  const availableTerminalIds = terminalIdsForPlatform(runtimePlatform);
  const terminalSupported = availableTerminalIds.length > 0;
  const commandDialect = commandDialectForTerminal(
    terminalSettings.terminal,
    runtimePlatform,
    terminalSettings.shellPath,
  );
  const searchShortcutLabel = runtimePlatform === "darwin" ? "⌘K" : "Ctrl K";
  const shortcutSurfaceOpen =
    showProviderSources || editingResumeCommand || editingTitle || collectionEditor !== null;

  const dismissActiveSurface = useCallback((): boolean => {
    if (showProviderSources) setShowProviderSources(false);
    else if (editingResumeCommand) setEditingResumeCommand(false);
    else if (editingTitle) setEditingTitle(false);
    else if (collectionEditor !== null) setCollectionEditor(null);
    else if (error !== null) setError(null);
    else if (notice !== null) setNotice(null);
    else if (query !== "") setQuery("");
    else if (document.activeElement === searchInputRef.current) searchInputRef.current?.blur();
    else return false;
    return true;
  }, [showProviderSources, editingResumeCommand, editingTitle, collectionEditor, error, notice, query]);

  useDialogFocus(
    showProviderSources,
    providerSourcesTriggerRef,
    providerSourcesCloseRef,
    providerSourcesWasOpenRef,
  );
  useAppKeyboardShortcuts({
    searchInputRef,
    surfaceOpen: shortcutSurfaceOpen,
    dismissActiveSurface,
    enabled: appView === "sessions",
  });

  const applyProviderSourceSettings = (settings: ProviderSourceSetting[]): void => {
    setProviderSourceSettings(settings);
    setProviderSourceDrafts(Object.fromEntries(
      settings.map((setting) => [setting.provider, {
        enabled: setting.enabled,
        home: setting.home,
      }]),
    ));
  };

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t("app.name");
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute("content", t("app.description"));
  }, [locale]);

  useEffect(() => {
    jsonRequest<{ providers: ProviderDescriptor[] }>("/api/providers")
      .then((data) => setProviderDescriptors(data.providers))
      .catch((caught: unknown) => setError(String(caught)));
    jsonRequest<{ templates: ResumeCommandTemplates }>("/api/settings/resume-commands")
      .then((data) => setResumeCommandTemplates(data.templates))
      .catch((caught: unknown) => setError(String(caught)));
    jsonRequest<{ settings: TerminalSettings }>("/api/settings/terminal")
      .then((data) => setTerminalSettings(data.settings))
      .catch((caught: unknown) => setError(String(caught)));
    jsonRequest<{ settings: ProviderSourceSetting[] }>("/api/settings/providers")
      .then((data) => applyProviderSourceSettings(data.settings))
      .catch((caught: unknown) => setError(String(caught)));
  }, []);

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), 2200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (provider === "all" || status === null) return;
    if ((status.counts[provider] ?? 0) === 0) {
      setProvider("all");
      setProjectPath("");
    }
  }, [provider, status]);

  const filters = useMemo(
    () => ({
      provider: provider === "all" ? undefined : provider,
      projectPath: projectPath || undefined,
      favorites: favoritesOnly,
      renamed: renamedOnly,
      collection: collectionFilter === "all" ? undefined : collectionFilter,
    }),
    [provider, projectPath, favoritesOnly, renamedOnly, collectionFilter],
  );

  const refreshSidebar = useCallback(async (): Promise<void> => {
    const suffix = queryString(filters);
    const [sessionData, projectData, statusData, collectionData] = await Promise.all([
      jsonRequest<{ sessions: SessionSummary[] }>(`/api/sessions?${suffix}`),
      jsonRequest<{ projects: Project[] }>("/api/projects"),
      jsonRequest<AppStatus>("/api/status"),
      jsonRequest<{ collections: CollectionSummary[] }>("/api/collections"),
    ]);
    setSessions(sessionData.sessions);
    setProjects(projectData.projects);
    setStatus(statusData);
    setCollections(collectionData.collections);
  }, [filters]);

  useEffect(() => {
    setLoading(true);
    refreshSidebar()
      .catch((caught: unknown) => setError(String(caught)))
      .finally(() => setLoading(false));
  }, [refreshSidebar]);

  useEffect(() => {
    if (status?.sync.running !== true) return;
    const timer = window.setInterval(() => {
      void refreshSidebar().catch((caught: unknown) => setError(String(caught)));
    }, 750);
    return () => window.clearInterval(timer);
  }, [status?.sync.running, refreshSidebar]);

  useEffect(() => {
    if (status === null) return;
    let active = true;
    let requestInFlight = false;
    const checkIndexStatus = async (): Promise<void> => {
      if (!active || requestInFlight || document.visibilityState === "hidden") return;
      requestInFlight = true;
      try {
        const data = await jsonRequest<{ sync: SyncProgress }>("/api/sync/status");
        if (!active) return;
        if (data.sync.revision !== status.sync.revision) {
          await refreshSidebar();
        } else {
          setStatus((current) => current === null ? current : { ...current, sync: data.sync });
        }
      } catch (caught) {
        if (active) setError(String(caught));
      } finally {
        requestInFlight = false;
      }
    };
    const timer = window.setInterval(() => void checkIndexStatus(), INDEX_STATUS_POLL_MS);
    const checkWhenVisible = (): void => {
      if (document.visibilityState === "visible") void checkIndexStatus();
    };
    document.addEventListener("visibilitychange", checkWhenVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", checkWhenVisible);
    };
  }, [status?.sync.revision, refreshSidebar]);

  useEffect(() => {
    if (debouncedQuery === "") {
      setResults([]);
      return;
    }
    setLoading(true);
    const suffix = queryString({ q: debouncedQuery, ...filters });
    jsonRequest<{ results: SearchResult[] }>(`/api/search?${suffix}`)
      .then((data) => setResults(data.results))
      .catch((caught: unknown) => setError(String(caught)))
      .finally(() => setLoading(false));
  }, [debouncedQuery, filters]);

  useEffect(() => {
    if (selectedMessageIndex === null) return;
    window.setTimeout(() => {
      messageRefs.current.get(selectedMessageIndex)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 30);
  }, [selected, selectedMessageIndex]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const container = messagesScrollRef.current;
      if (
        container === null ||
        selected === null ||
        activeSearchMatch?.sessionKey !== selected.session.sessionKey
      ) {
        setHighlightNavigation({ currentIndex: -1, total: 0 });
        return;
      }
      const highlights = [...container.querySelectorAll<HTMLElement>("mark.search-highlight")];
      highlights.forEach((highlight) => highlight.classList.remove("current-search-highlight"));
      const selectedMessage = selectedMessageIndex === null
        ? null
        : messageRefs.current.get(selectedMessageIndex) ?? null;
      const selectedHighlight = selectedMessage?.querySelector<HTMLElement>("mark.search-highlight") ?? null;
      const selectedHighlightIndex = selectedHighlight === null ? -1 : highlights.indexOf(selectedHighlight);
      if (selectedHighlightIndex >= 0) {
        highlights[selectedHighlightIndex]?.classList.add("current-search-highlight");
      }
      setHighlightNavigation({
        currentIndex: selectedHighlightIndex,
        total: highlights.length,
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSearchMatch, selected, selectedMessageIndex]);

  const scrollConversationTo = (position: "top" | "bottom"): void => {
    const container = messagesScrollRef.current;
    if (container === null) return;
    container.scrollTo({
      top: position === "top" ? 0 : container.scrollHeight,
      behavior: "smooth",
    });
  };

  const jumpToNextHighlight = (): void => {
    const container = messagesScrollRef.current;
    if (container === null) return;
    const highlights = [...container.querySelectorAll<HTMLElement>("mark.search-highlight")];
    const nextIndex = nextHighlightIndex(highlightNavigation.currentIndex, highlights.length);
    if (nextIndex < 0) return;
    highlights.forEach((highlight) => highlight.classList.remove("current-search-highlight"));
    highlights[nextIndex]?.classList.add("current-search-highlight");
    highlights[nextIndex]?.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightNavigation({ currentIndex: nextIndex, total: highlights.length });
  };

  const openSession = async (sessionKey: string, result?: SearchResult): Promise<void> => {
    setLoading(true);
    try {
      const detail = await jsonRequest<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionKey)}`);
      setSelected(detail);
      setSelectedMessageIndex(
        result !== undefined && result.messageIndex >= 0 ? result.messageIndex : null,
      );
      setActiveSearchMatch(
        result === undefined || debouncedQuery === ""
          ? null
          : {
              sessionKey,
              query: debouncedQuery,
            },
      );
      setEditingTitle(false);
      setEditingResumeCommand(false);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setLoading(false);
    }
  };

  const updateMetadata = async (
    session: SessionSummary,
    patch: { customTitle?: string | null; favorite?: boolean; collectionId?: number | null },
  ): Promise<void> => {
    const response = await jsonRequest<{ session: SessionSummary }>(
      `/api/sessions/${encodeURIComponent(session.sessionKey)}/metadata`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
    setSelected((current) =>
      current?.session.sessionKey === response.session.sessionKey
        ? { ...current, session: response.session }
        : current,
    );
    await refreshSidebar();
    if (debouncedQuery !== "") {
      const suffix = queryString({ q: debouncedQuery, ...filters });
      const data = await jsonRequest<{ results: SearchResult[] }>(`/api/search?${suffix}`);
      setResults(data.results);
    }
  };

  const saveTitle = async (): Promise<void> => {
    if (selected === null) return;
    await updateMetadata(selected.session, { customTitle: titleDraft.trim() || null });
    setEditingTitle(false);
  };

  const copySessionId = async (): Promise<void> => {
    if (selected === null) return;
    try {
      await copyText(selected.session.sourceSessionId, t("error.clipboardUnavailable"));
      setNotice(t("notice.sessionIdCopied"));
    } catch (caught) {
      setError(String(caught));
    }
  };

  const copyResumeCommand = async (): Promise<void> => {
    if (selected === null) return;
    const template = resumeCommandTemplates[selected.session.provider];
    if (template === undefined) return;
    const command = renderResumeCommand(template, {
      sessionId: selected.session.sourceSessionId,
      cwd: selected.session.projectPath,
    }, commandDialect);
    try {
      await copyText(command, t("error.clipboardUnavailable"));
      setNotice(t("notice.resumeCopied", { command }));
    } catch (caught) {
      setError(String(caught));
    }
  };

  const openResumeInTerminal = async (): Promise<void> => {
    if (selected === null) return;
    try {
      await jsonRequest(`/api/sessions/${encodeURIComponent(selected.session.sessionKey)}/open-terminal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      setNotice(t("notice.terminalLaunched"));
    } catch (caught) {
      setError(String(caught));
    }
  };

  const updateTerminalDraft = (nextTerminal: TerminalId): void => {
    setTerminalDraft(nextTerminal);
    if (runtimePlatform !== "win32") return;
    if (nextTerminal === "cmd") {
      setShellPathDraft("cmd.exe");
    } else if (nextTerminal === "powershell") {
      setShellPathDraft((current) => /(^|[\\/])pwsh(?:\.exe)?$/i.test(current) ? current : "powershell.exe");
    } else if (nextTerminal === "windows-terminal" && /(^|[\\/])cmd(?:\.exe)?$/i.test(shellPathDraft)) {
      setShellPathDraft("powershell.exe");
    }
  };

  const terminalLabel = (terminal: TerminalId): string => {
    if (terminal === "windows-terminal") return "Windows Terminal";
    if (terminal === "powershell") return "PowerShell";
    if (terminal === "cmd") return t("terminal.commandPrompt");
    if (terminal === "terminal") return "Terminal";
    if (terminal === "iterm2") return "iTerm2";
    if (terminal === "warp") return "Warp";
    return t("terminal.custom");
  };

  const saveCommandSettings = async (): Promise<void> => {
    if (selected === null || resumeCommandDraft.trim() === "") return;
    const customPath = customTerminalPathDraft.trim() || null;
    const shellPath = shellPathDraft.trim();
    if ((terminalDraft === "custom" && customPath === null) || shellPath === "") return;
    try {
      const [commandResponse, terminalResponse] = await Promise.all([
        jsonRequest<{ templates: ResumeCommandTemplates }>(
          `/api/settings/resume-commands/${selected.session.provider}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ template: resumeCommandDraft }),
          },
        ),
        jsonRequest<{ settings: TerminalSettings }>("/api/settings/terminal", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            terminal: terminalDraft,
            customPath: terminalDraft === "custom" ? customPath : null,
            shellPath,
          }),
        }),
      ]);
      setResumeCommandTemplates(commandResponse.templates);
      setTerminalSettings(terminalResponse.settings);
      setEditingResumeCommand(false);
      setNotice(
        t("notice.commandSettingsSaved", { provider: providerLabel(selected.session.provider) }),
      );
    } catch (caught) {
      setError(String(caught));
    }
  };

  const saveProviderSource = async (setting: ProviderSourceSetting): Promise<void> => {
    const draft = providerSourceDrafts[setting.provider];
    if (draft === undefined || draft.home.trim() === "") return;
    setSavingProviderSource(setting.provider);
    setLoading(true);
    try {
      const normalizedHome = draft.home.trim();
      const response = await jsonRequest<{ settings: ProviderSourceSetting[] }>(
        `/api/settings/providers/${setting.provider}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled: draft.enabled,
            home: normalizedHome === setting.defaultHome ? null : normalizedHome,
          }),
        },
      );
      applyProviderSourceSettings(response.settings);
      if (!draft.enabled && selected?.session.provider === setting.provider) setSelected(null);
      await refreshSidebar();
      if (debouncedQuery !== "") {
        const suffix = queryString({ q: debouncedQuery, ...filters });
        const data = await jsonRequest<{ results: SearchResult[] }>(`/api/search?${suffix}`);
        setResults(data.results);
      }
      setNotice(t("notice.providerSourceSaved", { provider: providerLabel(setting.provider) }));
    } catch (caught) {
      setError(String(caught));
    } finally {
      setSavingProviderSource(null);
      setLoading(false);
    }
  };

  const saveCollection = async (): Promise<void> => {
    const name = collectionNameDraft.trim();
    if (name === "") return;
    try {
      if (collectionEditor === "create") {
        const response = await jsonRequest<{ collection: CollectionSummary }>("/api/collections", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        setCollectionFilter(String(response.collection.id));
      } else if (collectionEditor === "rename") {
        const id = Number.parseInt(collectionFilter, 10);
        if (!Number.isInteger(id)) return;
        await jsonRequest(`/api/collections/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
      }
      setCollectionEditor(null);
      setCollectionNameDraft("");
      await refreshSidebar();
    } catch (caught) {
      setError(String(caught));
    }
  };

  const deleteSelectedCollection = async (): Promise<void> => {
    const id = Number.parseInt(collectionFilter, 10);
    if (!Number.isInteger(id)) return;
    const collection = collections.find((item) => item.id === id);
    if (
      collection === undefined ||
      !window.confirm(t("collection.deleteConfirm", { name: collection.name }))
    ) {
      return;
    }
    try {
      await jsonRequest(`/api/collections/${id}`, { method: "DELETE" });
      setCollectionFilter("all");
      setSelected((current) =>
        current?.session.collectionId === id
          ? { ...current, session: { ...current.session, collectionId: null } }
          : current,
      );
      setCollectionEditor(null);
      await refreshSidebar();
    } catch (caught) {
      setError(String(caught));
    }
  };

  const visibleItems: Array<SessionSummary | SearchResult> =
    debouncedQuery === "" ? sessions : results;
  const visibleProjects = projects.filter((project) => provider === "all" || project.provider === provider);
  const visibleProviders = providerDescriptors.filter(
    (item) => (status?.counts[item.id] ?? 0) > 0,
  );
  const collectionNames = new Map(collections.map((collection) => [collection.id, collection.name]));
  const syncProgress = status?.sync ?? null;

  const applySidebarWidth = (requestedWidth: number): number => {
    const width = clampSidebarWidth(requestedWidth, window.innerWidth);
    sidebarWidthRef.current = width;
    appShellRef.current?.style.setProperty("--sidebar-width", `${width}px`);
    return width;
  };

  const saveSidebarWidth = (width: number): void => {
    setSidebarWidth(width);
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(width));
    } catch {
      // Resizing remains available when storage is blocked.
    }
  };

  const sidebarResizer = (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-label={t("sidebar.resize")}
      aria-orientation="vertical"
      aria-valuemin={280}
      aria-valuemax={720}
      aria-valuenow={sidebarWidth}
      tabIndex={0}
      onDoubleClick={() => saveSidebarWidth(applySidebarWidth(DEFAULT_SIDEBAR_WIDTH))}
      onPointerDown={(event) => {
        resizingSidebarRef.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.classList.add("resizing-sidebar");
      }}
      onPointerMove={(event) => {
        if (!resizingSidebarRef.current) return;
        applySidebarWidth(event.clientX);
      }}
      onPointerUp={(event) => {
        if (!resizingSidebarRef.current) return;
        resizingSidebarRef.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
        document.body.classList.remove("resizing-sidebar");
        saveSidebarWidth(sidebarWidthRef.current);
      }}
      onPointerCancel={() => {
        resizingSidebarRef.current = false;
        document.body.classList.remove("resizing-sidebar");
        saveSidebarWidth(sidebarWidthRef.current);
      }}
      onKeyDown={(event) => {
        const delta = event.key === "ArrowLeft" ? -24 : event.key === "ArrowRight" ? 24 : 0;
        const requestedWidth =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? Number.MAX_SAFE_INTEGER
              : sidebarWidthRef.current + delta;
        if (delta === 0 && event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        saveSidebarWidth(applySidebarWidth(requestedWidth));
      }}
    />
  );

  if (appView === "contexts") {
    return (
      <div
        className="app-shell"
        ref={appShellRef}
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <ContextLibrary
          t={t}
          locale={locale}
          searchShortcutLabel={searchShortcutLabel}
          sidebarResizer={sidebarResizer}
          onShowSessions={() => {
            setAppView("sessions");
            void refreshSidebar().catch((caught: unknown) => setError(String(caught)));
          }}
        />
      </div>
    );
  }

  return (
    <div
      className="app-shell"
      ref={appShellRef}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <aside className="sidebar">
        <header className="brand">
          <div className="brand-mark">⌕</div>
          <div>
            <h1>AI Session Search</h1>
            <p>{t("app.tagline")}</p>
          </div>
          <UpdateNotification t={t} />
        </header>

        <AppViewTabs active="sessions" t={t} onChange={setAppView} />

        {syncProgress?.running === true && <IndexingStatus progress={syncProgress} t={t} />}

        <SearchBox
          inputRef={searchInputRef}
          query={query}
          shortcutLabel={searchShortcutLabel}
          t={t}
          onQueryChange={setQuery}
        />

        <div className="filters session-filters">
          <ProviderFilter
            providers={visibleProviders}
            value={provider}
            t={t}
            onChange={setProvider}
          />
          <ProjectFilter
            projects={visibleProjects}
            value={projectPath}
            t={t}
            onChange={setProjectPath}
          />
          <button
            className={favoritesOnly ? "filter-button active" : "filter-button"}
            aria-pressed={favoritesOnly}
            title={t("filter.favoritesOnly")}
            onClick={() => setFavoritesOnly((value) => !value)}
          >
            ★ {t("filter.favoritesOnly")}
          </button>
          <button
            className={renamedOnly ? "filter-button active" : "filter-button"}
            aria-pressed={renamedOnly}
            title={t("filter.renamedOnly")}
            onClick={() => setRenamedOnly((value) => !value)}
          >
            ✎ {t("filter.renamedOnly")}
          </button>
          <SelectControl
            className="collection-filter"
            value={collectionFilter}
            ariaLabel={t("filter.allCollections")}
            options={[
              { value: "all", label: t("filter.allCollections") },
              { value: "unassigned", label: t("collection.unassigned") },
              ...collections.map((collection) => ({
                value: String(collection.id),
                label: `${collection.name} (${collection.sessionCount})`,
              })),
            ]}
            onChange={(value) => {
              setCollectionFilter(value);
              setCollectionEditor(null);
            }}
          />
          <div className="collection-actions">
            <button
              onClick={() => {
                setCollectionNameDraft("");
                setCollectionEditor("create");
              }}
            >
              {t("collection.new")}
            </button>
            {Number.isInteger(Number.parseInt(collectionFilter, 10)) && (
              <>
                <button
                  onClick={() => {
                    const selectedCollection = collections.find(
                      (collection) => collection.id === Number.parseInt(collectionFilter, 10),
                    );
                    setCollectionNameDraft(selectedCollection?.name ?? "");
                    setCollectionEditor("rename");
                  }}
                >
                  {t("common.rename")}
                </button>
                <button className="danger" onClick={() => void deleteSelectedCollection()}>
                  {t("common.delete")}
                </button>
              </>
            )}
          </div>
          {collectionEditor !== null && (
            <div className="collection-editor">
              <input
                value={collectionNameDraft}
                onChange={(event) => setCollectionNameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void saveCollection();
                  if (event.key === "Escape") setCollectionEditor(null);
                }}
                placeholder={
                  collectionEditor === "create"
                    ? t("collection.newPlaceholder")
                    : t("collection.namePlaceholder")
                }
                maxLength={100}
                autoFocus
              />
              <button onClick={() => void saveCollection()}>{t("common.save")}</button>
              <button onClick={() => setCollectionEditor(null)}>{t("common.cancel")}</button>
            </div>
          )}
        </div>

        <div className="result-caption">
          <span>
            {debouncedQuery === ""
              ? t("sessions.recent")
              : t("sessions.searchResults", { query: debouncedQuery })}
          </span>
          <span>{visibleItems.length}</span>
        </div>

        <div className="result-list">
          {visibleItems.map((item) => {
            const result = isSearchResult(item) ? item : null;
            return (
              <button
                className={`session-row ${selected?.session.sessionKey === item.sessionKey ? "selected" : ""}`}
                key={result === null ? item.sessionKey : `${item.sessionKey}:${result.messageIndex}`}
                onClick={() => void openSession(item.sessionKey, result ?? undefined)}
              >
                <div className="session-row-title">
                  <span className="provider-dot" style={{ background: providerColor(item.provider) }} />
                  <strong>
                    <HighlightedText
                      text={item.displayTitle}
                      query={result === null ? "" : debouncedQuery}
                    />
                  </strong>
                  {item.favorite && <span className="favorite-star">★</span>}
                </div>
                {item.collectionId !== null && (
                  <span className="collection-badge">
                    ▰ {collectionNames.get(item.collectionId) ?? t("collection.fallback")}
                  </span>
                )}
                {item.customTitle !== null && (
                  <p className="original-title">
                    {t("session.original", { title: item.originalTitle })}
                  </p>
                )}
                {result !== null && (
                  <p className="snippet">
                    <HighlightedText text={result.snippet} query={debouncedQuery} />
                  </p>
                )}
                <div className="session-meta">
                  <span>{providerLabel(item.provider)}</span>
                  <time>{formatDate(item.updatedAt, locale)}</time>
                </div>
              </button>
            );
          })}
          {!loading && visibleItems.length === 0 && (
            <div className="empty-state">{t("sessions.empty")}</div>
          )}
        </div>

        <footer className="sidebar-footer">
          {status?.providers
            .filter((item) => status.counts[item.provider] > 0)
            .map((item) => (
              <span key={item.provider}>{providerLabel(item.provider)} {status.counts[item.provider]}</span>
            ))}
          <button
            ref={providerSourcesTriggerRef}
            onClick={() => setShowProviderSources(true)}
            title={t("sources.openShortcutHint")}
          >
            {t("sources.open")}
          </button>
          <button
            disabled={syncProgress?.running === true}
            onClick={() => {
              setLoading(true);
              void jsonRequest("/api/sync", { method: "POST" })
                .then(refreshSidebar)
                .finally(() => setLoading(false));
            }}
          >
            {t("sessions.rescan")}
          </button>
        </footer>
      </aside>

      {sidebarResizer}

      <main className="conversation-pane">
        {selected === null ? (
          <div className="welcome">
            <div className="welcome-icon">⌕</div>
            <h2>{t("welcome.title")}</h2>
            <p>{t("welcome.description")}</p>
            <div className="provider-status">
              {status?.providers.filter((item) => status.counts[item.provider] > 0).map((item) => (
                <div key={item.provider}>
                  <span className={`status-light ${item.detected ? "detected" : ""}`} />
                  <strong>{providerLabel(item.provider)}</strong>
                  <code>{item.home}</code>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <>
            <header className="conversation-header">
              <div className="header-title">
                <span className="provider-pill" style={{ background: providerColor(selected.session.provider) }}>
                  {providerLabel(selected.session.provider)}
                </span>
                {editingTitle ? (
                  <div className="rename-form">
                    <input
                      value={titleDraft}
                      onChange={(event) => setTitleDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void saveTitle();
                        if (event.key === "Escape") setEditingTitle(false);
                      }}
                      maxLength={200}
                      autoFocus
                    />
                    <button onClick={() => void saveTitle()}>{t("common.save")}</button>
                    <button onClick={() => setEditingTitle(false)}>{t("common.cancel")}</button>
                  </div>
                ) : (
                  <h2 title={selected.session.displayTitle}>
                    <HighlightedText
                      text={selected.session.displayTitle}
                      query={
                        activeSearchMatch?.sessionKey === selected.session.sessionKey
                          ? activeSearchMatch.query
                          : ""
                      }
                    />
                  </h2>
                )}
                {selected.session.customTitle !== null && !editingTitle && (
                  <p>{t("session.originalTitle", { title: selected.session.originalTitle })}</p>
                )}
              </div>
              <div className="header-actions">
                <button title={t("session.copyId")} onClick={() => void copySessionId()}>
                  {t("session.copyId")}
                </button>
                {resumeCommandTemplates[selected.session.provider] !== undefined && (
                  <>
                    <button title={t("session.copyResume")} onClick={() => void copyResumeCommand()}>
                      {t("session.copyResume")}
                    </button>
                    {terminalSupported && (
                      <button title={t("session.openTerminal")} onClick={() => void openResumeInTerminal()}>
                        {t("session.openTerminal")}
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setResumeCommandDraft(resumeCommandTemplates[selected.session.provider] ?? "");
                        setTerminalDraft(terminalSettings.terminal);
                        setCustomTerminalPathDraft(terminalSettings.customPath ?? "");
                        setShellPathDraft(terminalSettings.shellPath);
                        setEditingResumeCommand((value) => !value);
                      }}
                    >
                      {t("resume.settings")}
                    </button>
                  </>
                )}
                <button
                  title={
                    selected.session.favorite ? t("favorite.remove") : t("favorite.add")
                  }
                  aria-label={
                    selected.session.favorite ? t("favorite.remove") : t("favorite.add")
                  }
                  className={selected.session.favorite ? "star-button active" : "star-button"}
                  onClick={() => void updateMetadata(selected.session, { favorite: !selected.session.favorite })}
                >
                  ★
                </button>
                <button
                  onClick={() => {
                    setTitleDraft(selected.session.customTitle ?? selected.session.originalTitle);
                    setEditingTitle(true);
                  }}
                >
                  {t("common.rename")}
                </button>
              </div>
              <div className="conversation-info">
                <code>{selected.session.projectPath ?? t("session.unknownProject")}</code>
                <span>{t("session.messageCount", { count: selected.session.messageCount })}</span>
                <time>{formatDate(selected.session.updatedAt, locale)}</time>
                <div className="collection-assignment">
                  <span>{t("collection.label")}</span>
                  <SelectControl
                    value={selected.session.collectionId === null ? "" : String(selected.session.collectionId)}
                    ariaLabel={t("collection.label")}
                    options={[
                      { value: "", label: t("collection.unassigned") },
                      ...collections.map((collection) => ({
                        value: String(collection.id),
                        label: collection.name,
                      })),
                    ]}
                    onChange={(value) => {
                      void updateMetadata(selected.session, {
                        collectionId: value === "" ? null : Number.parseInt(value, 10),
                      });
                    }}
                  />
                </div>
              </div>
              {editingResumeCommand && (
                <div className="resume-command-editor">
                  <label htmlFor="resume-command-template">
                    {t("resume.template", {
                      provider: providerLabel(selected.session.provider),
                    })}
                  </label>
                  <div className="resume-command-form">
                    <input
                      id="resume-command-template"
                      value={resumeCommandDraft}
                      onChange={(event) => setResumeCommandDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void saveCommandSettings();
                        if (event.key === "Escape") setEditingResumeCommand(false);
                      }}
                      maxLength={500}
                      autoFocus
                    />
                    <button onClick={() => void saveCommandSettings()}>{t("common.save")}</button>
                    <button
                      onClick={() =>
                        setResumeCommandDraft(DEFAULT_RESUME_COMMAND_TEMPLATES[selected.session.provider] ?? "")
                      }
                    >
                      {t("resume.restoreDefault")}
                    </button>
                    <button onClick={() => setEditingResumeCommand(false)}>
                      {t("common.cancel")}
                    </button>
                  </div>
                  <p>
                    {t("resume.templateHelp", {
                      cwd: "{cwd}",
                      sessionId: "{sessionId}",
                    })}
                  </p>
                  {resumeCommandDraft.trim() !== "" && (
                    <code className="command-preview">
                      {renderResumeCommand(resumeCommandDraft, {
                        sessionId: selected.session.sourceSessionId,
                        cwd: selected.session.projectPath,
                      }, commandDialect)}
                    </code>
                  )}
                  {terminalSupported && (
                    <>
                      <div className="terminal-settings">
                        <label htmlFor="terminal-kind">{t("terminal.type")}</label>
                        <SelectControl
                          id="terminal-kind"
                          value={terminalDraft}
                          ariaLabel={t("terminal.type")}
                          options={availableTerminalIds.map((terminal) => ({
                            value: terminal,
                            label: terminalLabel(terminal),
                          }))}
                          onChange={updateTerminalDraft}
                        />
                        {terminalDraft === "custom" && (
                          <input
                            value={customTerminalPathDraft}
                            onChange={(event) => setCustomTerminalPathDraft(event.target.value)}
                            placeholder={runtimePlatform === "win32" ? "C:\\Program Files\\WezTerm\\wezterm-gui.exe" : "/Applications/Ghostty.app"}
                            maxLength={1000}
                          />
                        )}
                      </div>
                      <div className="terminal-settings shell-settings">
                        <label htmlFor="terminal-shell-path">
                          {runtimePlatform === "win32" ? t("terminal.shellExecutable") : t("terminal.shellPath")}
                        </label>
                        <input
                          id="terminal-shell-path"
                          value={shellPathDraft}
                          onChange={(event) => setShellPathDraft(event.target.value)}
                          placeholder={runtimePlatform === "win32" ? "powershell.exe" : "/bin/zsh"}
                          maxLength={1000}
                        />
                      </div>
                      <p>{runtimePlatform === "win32" ? t("terminal.windowsPathHelp") : t("terminal.pathHelp")}</p>
                      <p>{runtimePlatform === "win32" ? t("terminal.windowsShellHelp") : t("terminal.shellPathHelp")}</p>
                    </>
                  )}
                </div>
              )}
            </header>

            <div className="messages" ref={messagesScrollRef}>
              {selected.messages.map((message) => (
                <article
                  key={message.index}
                  ref={(element) => {
                    if (element === null) messageRefs.current.delete(message.index);
                    else messageRefs.current.set(message.index, element);
                  }}
                  className={`message ${message.role} ${selectedMessageIndex === message.index ? "matched" : ""}`}
                >
                  <div className="message-label">
                    <strong>
                      {message.role === "user"
                        ? t("message.you")
                        : providerLabel(selected.session.provider)}
                    </strong>
                    {message.phase !== undefined && (
                      <span>
                        {message.phase === "commentary"
                          ? t("message.phase.commentary")
                          : t("message.phase.finalAnswer")}
                      </span>
                    )}
                    <time>{formatDate(message.timestamp, locale)}</time>
                  </div>
                  <pre>
                    <HighlightedText
                      text={message.content}
                      query={
                        activeSearchMatch?.sessionKey === selected.session.sessionKey
                          ? activeSearchMatch.query
                          : ""
                      }
                    />
                  </pre>
                </article>
              ))}
            </div>
            <ConversationNavigation
              currentHighlightIndex={highlightNavigation.currentIndex}
              highlightCount={highlightNavigation.total}
              labels={{
                navigation: t("conversation.navigation"),
                top: t("conversation.top"),
                nextHighlight: t("conversation.nextHighlight"),
                bottom: t("conversation.bottom"),
              }}
              onTop={() => scrollConversationTo("top")}
              onNextHighlight={jumpToNextHighlight}
              onBottom={() => scrollConversationTo("bottom")}
            />
          </>
        )}
      </main>

      {showProviderSources && (
        <ProviderSourcesDialog
          settings={providerSourceSettings}
          drafts={providerSourceDrafts}
          savingProvider={savingProviderSource}
          closeButtonRef={providerSourcesCloseRef}
          t={t}
          onClose={() => setShowProviderSources(false)}
          onDraftChange={(provider, draft) => setProviderSourceDrafts((current) => ({
            ...current,
            [provider]: draft,
          }))}
          onSave={(setting) => void saveProviderSource(setting)}
        />
      )}

      {loading && <div className="loading-bar" />}
      {error !== null && (
        <button className="error-toast" onClick={() => setError(null)}>
          {error}
        </button>
      )}
      {notice !== null && (
        <button className="notice-toast" onClick={() => setNotice(null)}>
          {notice}
        </button>
      )}
    </div>
  );
};
