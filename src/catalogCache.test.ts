import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readCatalogPages,
  readModelDetails,
  writeCatalogPage,
  writeModelDetails,
} from "./catalogCache";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("persistent catalog cache", () => {
  it("persists catalog pages and model details and replaces stale pages on page one", async () => {
    const filterKey = `cache-test-${crypto.randomUUID()}`;
    await writeCatalogPage(filterKey, {
      page: 1,
      models: [
        {
          name: "cached-model",
          description: "Cached model",
          capabilities: [],
          downloads: null,
          sizes: ["1b"],
        },
      ],
      hasMore: true,
      savedAt: Date.now(),
    });
    await writeCatalogPage(filterKey, {
      page: 2,
      models: [
        {
          name: "old-page-two",
          description: "Old page two",
          capabilities: [],
          downloads: null,
          sizes: ["2b"],
        },
      ],
      hasMore: false,
      savedAt: Date.now(),
    });
    await writeCatalogPage(filterKey, {
      page: 1,
      models: [
        {
          name: "refreshed-model",
          description: "Fresh first page",
          capabilities: [],
          downloads: null,
          sizes: ["3b"],
        },
      ],
      hasMore: true,
      savedAt: Date.now(),
    });
    await writeModelDetails("cached-model", {
      variants: [{ tag: "1b", downloadSize: "700MB" }],
      downloadSize: "700MB",
    });

    await expect(readCatalogPages(filterKey)).resolves.toMatchObject([
      { page: 1, models: [{ name: "refreshed-model" }], hasMore: true },
    ]);
    await expect(readModelDetails("cached-model")).resolves.toMatchObject({
      value: {
        variants: [{ tag: "1b", downloadSize: "700MB" }],
        downloadSize: "700MB",
      },
    });
    await expect(readCatalogPages("different-filter")).resolves.toEqual([]);
  });

  it("ignores malformed records and records beyond the retention period", async () => {
    const filterKey = `corrupt-test-${crypto.randomUUID()}`;
    await readCatalogPages(filterKey);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("lokvyn-discovery-cache", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("catalog-pages", "readwrite");
    transaction.objectStore("catalog-pages").put({
      key: `${filterKey}:1`,
      filterKey,
      page: 1,
      models: "invalid",
      hasMore: false,
      savedAt: Date.now(),
    });
    transaction.objectStore("catalog-pages").put({
      key: `${filterKey}:2`,
      filterKey,
      page: 2,
      models: [],
      hasMore: false,
      savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
    });
    await new Promise<void>((resolve) => {
      transaction.oncomplete = () => resolve();
    });

    await expect(readCatalogPages(filterKey)).resolves.toEqual([]);
    database.close();
  });

  it("ignores corrupt model fields and null variants without throwing", async () => {
    const filterKey = `invalid-fields-${crypto.randomUUID()}`;
    await readCatalogPages(filterKey);
    const database = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("lokvyn-discovery-cache", 1);
      request.onsuccess = () => resolve(request.result);
    });
    const transaction = database.transaction(
      ["catalog-pages", "model-details"],
      "readwrite",
    );
    transaction.objectStore("catalog-pages").put({
      key: `${filterKey}:1`,
      filterKey,
      page: 1,
      hasMore: false,
      savedAt: Date.now(),
      models: [
        {
          name: "bad",
          description: "Bad",
          capabilities: [null],
          sizes: [],
          downloads: {},
        },
      ],
    });
    transaction.objectStore("model-details").put({
      key: filterKey,
      savedAt: Date.now(),
      value: { variants: [null] },
    });
    await new Promise<void>((resolve) => {
      transaction.oncomplete = () => resolve();
    });
    await expect(readCatalogPages(filterKey)).resolves.toEqual([]);
    await expect(readModelDetails(filterKey)).resolves.toBeNull();
    database.close();
  });

  it("falls back when IndexedDB is unavailable", async () => {
    vi.resetModules();
    vi.stubGlobal("indexedDB", undefined);
    const cache = await import("./catalogCache");
    await expect(cache.readCatalogPages("unavailable")).resolves.toEqual([]);
    await expect(cache.readModelDetails("unavailable")).resolves.toBeNull();
    await expect(
      cache.writeModelDetails("unavailable", { downloadSize: "1GB" }),
    ).resolves.toBeUndefined();
  });

  it("evicts old pages and details and excludes expired details", async () => {
    const filterKey = `bounded-${crypto.randomUUID()}`;
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, "now");
    for (let page = 1; page <= 102; page += 1) {
      clock.mockReturnValue(startedAt + page);
      await writeCatalogPage(filterKey, {
        page,
        models: [],
        hasMore: true,
        savedAt: Date.now(),
      });
    }
    const pages = await readCatalogPages(filterKey);
    expect(pages).toHaveLength(100);
    expect(pages.some((page) => page.page === 1)).toBe(false);
    for (let index = 0; index < 502; index += 1) {
      clock.mockReturnValue(startedAt + 103 + index);
      await writeModelDetails(`${filterKey}-${index}`, { downloadSize: "1GB" });
    }
    await expect(readModelDetails(`${filterKey}-0`)).resolves.toBeNull();
    await expect(readModelDetails(`${filterKey}-501`)).resolves.toMatchObject({
      value: { downloadSize: "1GB" },
    });
    clock.mockReturnValue(Date.now() + 8 * 24 * 60 * 60 * 1000);
    await expect(readModelDetails(`${filterKey}-501`)).resolves.toBeNull();
  });

  it("preserves previously saved details if a storage transaction fails", async () => {
    const modelName = `quota-${crypto.randomUUID()}`;
    await writeModelDetails(modelName, { downloadSize: "1GB" });
    const transaction = vi
      .spyOn(IDBDatabase.prototype, "transaction")
      .mockImplementation(() => {
        throw new DOMException("Storage full", "QuotaExceededError");
      });
    await expect(
      writeModelDetails(modelName, { downloadSize: "2GB" }),
    ).resolves.toBeUndefined();
    await expect(readModelDetails(modelName)).resolves.toBeNull();
    transaction.mockRestore();
    await expect(readModelDetails(modelName)).resolves.toMatchObject({
      value: { downloadSize: "1GB" },
    });
  });

  it("falls back when opening IndexedDB never completes", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal("indexedDB", { open: () => ({}) });
    const cache = await import("./catalogCache");
    const result = cache.readCatalogPages("unresponsive");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toEqual([]);
    vi.useRealTimers();
  });
});
