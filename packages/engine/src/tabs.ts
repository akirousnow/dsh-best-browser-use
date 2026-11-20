export interface ManagedTabIdentity {
  url: string;
  title: string;
}

export interface ManagedTabEntry<TPage> {
  tabId: string;
  page: TPage;
  url: string;
  title: string;
  active: boolean;
}

/**
 * Maintains stable `$t1`, `$t2`, ... tab references across calls and reconnects.
 * When a browser/Relay reconnect happens and Playwright surfaces new Page handles,
 * TabManager matches them back to their original `$tN` IDs via URL + Title.
 */
export class TabManager<TPage> {
  private nextId = 1;
  private activeTabId: string | null = null;
  private readonly pageToId = new Map<TPage, string>();
  private readonly idToPage = new Map<string, TPage>();
  private readonly lastKnownMeta = new Map<string, ManagedTabIdentity>();

  getActiveTabId(): string | null {
    return this.activeTabId;
  }

  setActiveTabId(tabId: string): void {
    if (!this.idToPage.has(tabId)) {
      throw new Error(`Unknown tab "${tabId}". Call browser_tabs to inspect available tabs.`);
    }
    this.activeTabId = tabId;
  }

  /** Synchronize current live page list, rebinding `$tN` IDs after reconnects by URL+Title. */
  sync(
    pages: Array<{ page: TPage; url: string; title: string }>,
  ): ManagedTabEntry<TPage>[] {
    const liveSet = new Set(pages.map((p) => p.page));

    // Remove dead page mappings first
    for (const [id, page] of this.idToPage.entries()) {
      if (!liveSet.has(page)) {
        this.idToPage.delete(id);
        this.pageToId.delete(page);
      }
    }

    // Any remembered tab ID in lastKnownMeta not currently bound to a live page is eligible for rebinding
    // (covers both partial tab reload and full disconnect via markDisconnected()).
    const detachedIds: Array<{ tabId: string; meta: ManagedTabIdentity }> = [];
    for (const [id, meta] of this.lastKnownMeta.entries()) {
      if (!this.idToPage.has(id)) {
        detachedIds.push({ tabId: id, meta });
      }
    }

    const reclaimed = new Set<string>();
    const entries: ManagedTabEntry<TPage>[] = [];

    for (const item of pages) {
      let tabId = this.pageToId.get(item.page);

      if (!tabId) {
        // Attempt reconnect rebinding: exact URL + title first, then exact URL
        const exactMatch = detachedIds.find(
          (d) => !reclaimed.has(d.tabId) && d.meta.url === item.url && d.meta.title === item.title,
        );
        const urlMatch =
          exactMatch ??
          detachedIds.find(
            (d) => !reclaimed.has(d.tabId) && d.meta.url === item.url && item.url !== 'about:blank',
          );

        if (urlMatch) {
          tabId = urlMatch.tabId;
          reclaimed.add(tabId);
        } else {
          tabId = `$t${this.nextId++}`;
        }

        this.pageToId.set(item.page, tabId);
        this.idToPage.set(tabId, item.page);
      }

      this.lastKnownMeta.set(tabId, { url: item.url, title: item.title });
      entries.push({
        tabId,
        page: item.page,
        url: item.url,
        title: item.title,
        active: false,
      });
    }

    // Prune un-reclaimed detached entries after sync
    for (const d of detachedIds) {
      if (!reclaimed.has(d.tabId)) {
        this.lastKnownMeta.delete(d.tabId);
      }
    }

    if (!this.activeTabId || !this.idToPage.has(this.activeTabId)) {
      this.activeTabId = entries[0]?.tabId ?? null;
    }

    for (const entry of entries) {
      entry.active = entry.tabId === this.activeTabId;
    }

    return entries;
  }

  registerNewPage(page: TPage, url: string, title: string, select = true): string {
    let tabId = this.pageToId.get(page);
    if (!tabId) {
      tabId = `$t${this.nextId++}`;
      this.pageToId.set(page, tabId);
      this.idToPage.set(tabId, page);
    }
    this.lastKnownMeta.set(tabId, { url, title });
    if (select || !this.activeTabId) {
      this.activeTabId = tabId;
    }
    return tabId;
  }

  removeTab(tabId: string): void {
    const page = this.idToPage.get(tabId);
    if (page) {
      this.pageToId.delete(page);
    }
    this.idToPage.delete(tabId);
    this.lastKnownMeta.delete(tabId);
    if (this.activeTabId === tabId) {
      const next = this.idToPage.keys().next();
      this.activeTabId = next.done ? null : next.value;
    }
  }

  resolve(tabId?: string): { tabId: string; page: TPage } {
    const resolvedId = tabId ?? this.activeTabId;
    if (!resolvedId) {
      throw new Error('No open browser tab available. Use browser_new_tab to open a page first.');
    }
    const page = this.idToPage.get(resolvedId);
    if (!page) {
      throw new Error(`Tab "${resolvedId}" not found. Call browser_tabs to see current tabs.`);
    }
    return { tabId: resolvedId, page };
  }

  /** Clear live handles on disconnect while preserving lastKnownMeta for reconnect rebinding. */
  markDisconnected(): void {
    this.pageToId.clear();
    this.idToPage.clear();
  }
}
