import { CachedCutout } from '../types';

const DB_NAME = 'id_photo_cutout_cache_v1';
const STORE_NAME = 'cutouts';
const DB_VERSION = 1;
const MAX_CACHE_ITEMS = 4;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前浏览器不支持 IndexedDB'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开本地缓存失败'));
  });
}

export async function listCachedCutouts(): Promise<CachedCutout[]> {
  try {
    const db = await openDb();
    return await new Promise<CachedCutout[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = (req.result as CachedCutout[]) || [];
        rows.sort((a, b) => b.createdAt - a.createdAt);
        resolve(rows.slice(0, MAX_CACHE_ITEMS));
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function saveCachedCutout(
  blob: Blob,
  width: number,
  height: number
): Promise<CachedCutout[]> {
  try {
    const db = await openDb();
    const record: CachedCutout = {
      id: `cutout_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      createdAt: Date.now(),
      blob,
      width,
      height,
    };

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // Enforce max 4 most recent items
    const all = await new Promise<CachedCutout[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve((req.result as CachedCutout[]) || []);
      req.onerror = () => reject(req.error);
    });

    all.sort((a, b) => b.createdAt - a.createdAt);
    const toDelete = all.slice(MAX_CACHE_ITEMS);
    if (toDelete.length > 0) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const item of toDelete) {
          store.delete(item.id);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    return all.slice(0, MAX_CACHE_ITEMS);
  } catch {
    return [];
  }
}

export async function deleteCachedCutout(id: string): Promise<CachedCutout[]> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return await listCachedCutouts();
  } catch {
    return [];
  }
}
