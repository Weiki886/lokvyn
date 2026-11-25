import type { CatalogModel } from "./WorkspaceViews";

const DATABASE_NAME = "lokvyn-discovery-cache";
const DATABASE_VERSION = 1;
const CATALOG_STORE = "catalog-pages";
const DETAILS_STORE = "model-details";
const MAX_CATALOG_PAGES = 100;
const MAX_MODEL_DETAILS = 500;
const MAX_CACHE_AGE = 7 * 24 * 60 * 60 * 1000;

export type CachedCatalogPage = {
  page: number;
  models: CatalogModel[];
  hasMore: boolean;
  savedAt: number;
};

export type CachedModelDetails = {
  value: {
    variants?: { tag: string; downloadSize: string | null }[];
    downloadSize?: string | null;
  };
  savedAt: number;
};

type CatalogRecord = CachedCatalogPage & { key: string; filterKey: string };
type DetailsRecord = CachedModelDetails & { key: string };

let databasePromise: Promise<IDBDatabase | null> | undefined;

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    try {
      let settled = false;
      const finish = (database: IDBDatabase | null) => {
        if (settled) {
          database?.close();
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(database);
      };
      const timeout = setTimeout(() => finish(null), 1000);
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(CATALOG_STORE))
          database.createObjectStore(CATALOG_STORE, { keyPath: "key" });
        if (!database.objectStoreNames.contains(DETAILS_STORE))
          database.createObjectStore(DETAILS_STORE, { keyPath: "key" });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        finish(request.result);
      };
      request.onerror = () => finish(null);
      request.onblocked = () => finish(null);
    } catch {
      resolve(null);
    }
  });
  return databasePromise;
}

function readStore<T>(storeName: string): Promise<T[]> {
  return openDatabase().then(
    (database) =>
      new Promise<T[]>((resolve) => {
        if (!database) return resolve([]);
        try {
          const request = database
            .transaction(storeName, "readonly")
            .objectStore(storeName)
            .getAll();
          request.onsuccess = () => resolve(request.result as T[]);
          request.onerror = () => resolve([]);
        } catch {
          resolve([]);
        }
      }),
  );
}

function readRecord<T>(storeName: string, key: string): Promise<T | null> {
  return openDatabase().then(
    (database) =>
      new Promise<T | null>((resolve) => {
        if (!database) return resolve(null);
        try {
          const request = database
            .transaction(storeName, "readonly")
            .objectStore(storeName)
            .get(key);
          request.onsuccess = () =>
            resolve((request.result as T | undefined) ?? null);
          request.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

async function evictOldRecords<T extends { key: string; savedAt: number }>(
  storeName: string,
  maxRecords: number,
) {
  const database = await openDatabase();
  if (!database) return;
  await new Promise<void>((resolve) => {
    try {
      const transaction = database.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const request = store.getAll();
      request.onsuccess = () => {
        const records = (request.result as (T & { key: string })[]).sort(
          (left, right) => Number(right.savedAt) - Number(left.savedAt),
        );
        const now = Date.now();
        let retained = 0;
        for (const candidate of records) {
          const isExpired =
            !Number.isFinite(candidate.savedAt) ||
            candidate.savedAt > now ||
            now - candidate.savedAt > MAX_CACHE_AGE;
          if (isExpired || retained >= maxRecords) store.delete(candidate.key);
          else retained += 1;
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function writeBoundedRecord<T extends { key: string; savedAt: number }>(
  storeName: string,
  record: T,
  maxRecords: number,
) {
  const database = await openDatabase();
  if (!database) return;
  await new Promise<void>((resolve) => {
    try {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  await evictOldRecords(storeName, maxRecords);
}

function catalogRecordKey(filterKey: string, page: number) {
  return `${filterKey}:${page}`;
}

function isDetailsValue(value: unknown): value is CachedModelDetails["value"] {
  if (typeof value !== "object" || value === null) return false;
  const details = value as CachedModelDetails["value"];
  return (
    (details.downloadSize === undefined ||
      details.downloadSize === null ||
      typeof details.downloadSize === "string") &&
    (details.variants === undefined ||
      (Array.isArray(details.variants) &&
        details.variants.every(
          (variant) =>
            typeof variant === "object" &&
            variant !== null &&
            typeof variant.tag === "string" &&
            (variant.downloadSize === null ||
              typeof variant.downloadSize === "string"),
        )))
  );
}

function isCatalogRecord(value: unknown): value is CatalogRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<CatalogRecord>;
  return (
    typeof record.key === "string" &&
    typeof record.filterKey === "string" &&
    Number.isInteger(record.page) &&
    Number(record.page) > 0 &&
    typeof record.hasMore === "boolean" &&
    Number.isFinite(record.savedAt) &&
    Array.isArray(record.models) &&
    record.models.every(
      (model) =>
        typeof model === "object" &&
        model !== null &&
        typeof model.name === "string" &&
        typeof model.description === "string" &&
        Array.isArray(model.capabilities) &&
        model.capabilities.every(
          (capability: unknown) => typeof capability === "string",
        ) &&
        Array.isArray(model.sizes) &&
        model.sizes.every((size: unknown) => typeof size === "string") &&
        (model.cloud === undefined || typeof model.cloud === "boolean") &&
        (model.downloads === null || typeof model.downloads === "string") &&
        isDetailsValue(model),
    )
  );
}

function isDetailsRecord(value: unknown): value is DetailsRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<DetailsRecord>;
  return (
    typeof record.key === "string" &&
    Number.isFinite(record.savedAt) &&
    isDetailsValue(record.value)
  );
}

export async function readCatalogPages(filterKey: string) {
  const records = await readStore<CatalogRecord>(CATALOG_STORE);
  const now = Date.now();
  const validRecords = records.filter(
    (record) =>
      isCatalogRecord(record) &&
      record.savedAt <= now &&
      now - record.savedAt <= MAX_CACHE_AGE,
  );
  return validRecords
    .filter((record) => record.filterKey === filterKey)
    .sort((left, right) => left.page - right.page)
    .map(({ page, models, hasMore, savedAt }) => ({
      page,
      models,
      hasMore,
      savedAt,
    }))
    .filter((record) => record.models.length <= 200);
}

export async function writeCatalogPage(
  filterKey: string,
  page: CachedCatalogPage,
) {
  if (
    !Number.isInteger(page.page) ||
    page.page < 1 ||
    page.models.length > 200 ||
    !Number.isFinite(page.savedAt) ||
    page.savedAt > Date.now()
  )
    return;
  const database = await openDatabase();
  if (!database) return;
  await new Promise<void>((resolve) => {
    try {
      const transaction = database.transaction(CATALOG_STORE, "readwrite");
      const store = transaction.objectStore(CATALOG_STORE);
      if (page.page === 1) {
        const request = store.getAll();
        request.onsuccess = () => {
          for (const record of request.result as CatalogRecord[]) {
            if (record.filterKey === filterKey) store.delete(record.key);
          }
          store.put({
            ...page,
            filterKey,
            key: catalogRecordKey(filterKey, page.page),
          });
        };
      } else {
        store.put({
          ...page,
          filterKey,
          key: catalogRecordKey(filterKey, page.page),
        });
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  await evictOldRecords(CATALOG_STORE, MAX_CATALOG_PAGES);
}

export async function readModelDetails(modelName: string) {
  const value = await readRecord<unknown>(DETAILS_STORE, modelName);
  if (!isDetailsRecord(value)) return null;
  if (value.savedAt > Date.now() || Date.now() - value.savedAt > MAX_CACHE_AGE)
    return null;
  const record = value;
  return { value: record.value, savedAt: record.savedAt };
}

export function writeModelDetails(
  modelName: string,
  details: CachedModelDetails["value"],
) {
  return writeBoundedRecord<DetailsRecord>(
    DETAILS_STORE,
    { key: modelName, value: details, savedAt: Date.now() },
    MAX_MODEL_DETAILS,
  );
}
