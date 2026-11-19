/**
 * IndexedDB 薄封装（任务要求：构型与孔探记录全部存浏览器本地）。
 * 无第三方依赖，Promise 化，库名/版本集中管理。
 */

const DB_NAME = 'borescope-planner-db';
const DB_VERSION = 1;

export const STORES = {
  engines: 'engines',
  probes: 'probes',
  records: 'records',
  damages: 'damages',
  blobs: 'blobs',
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function idbPut<T extends { id: string }>(store: StoreName, value: T): Promise<void> {
  await tx(store, 'readwrite', (s) => s.put(value) as IDBRequest<IDBValidKey>);
}

export async function idbGet<T>(store: StoreName, id: string): Promise<T | undefined> {
  return tx(store, 'readonly', (s) => s.get(id) as IDBRequest<T | undefined>);
}

export async function idbGetAll<T>(store: StoreName): Promise<T[]> {
  return tx(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}

export async function idbDelete(store: StoreName, id: string): Promise<void> {
  await tx(store, 'readwrite', (s) => s.delete(id) as IDBRequest<undefined>);
}

export async function idbClear(store: StoreName): Promise<void> {
  await tx(store, 'readwrite', (s) => s.clear() as IDBRequest<undefined>);
}

export async function idbBulkPut<T extends { id: string }>(store: StoreName, values: T[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    for (const v of values) s.put(v);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/** 全库导出（质量部交接文件） */
export async function exportAll(): Promise<Record<StoreName, unknown[]>> {
  const result = {} as Record<StoreName, unknown[]>;
  for (const name of Object.values(STORES)) {
    result[name] = await idbGetAll(name);
  }
  return result;
}

/** 全库导入（合并策略：同 id 覆盖） */
export async function importAll(data: Partial<Record<StoreName, { id: string }[]>>): Promise<void> {
  for (const name of Object.values(STORES)) {
    const rows = data[name];
    if (Array.isArray(rows) && rows.length) await idbBulkPut(name, rows);
  }
}
