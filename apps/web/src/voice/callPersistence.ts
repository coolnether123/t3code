import type { SavedCall, VoiceDependencies } from "@t3tools/client-runtime/voice-call";

/** IndexedDB keeps audio off synchronous localStorage and survives page reloads. */
export function callPersistence(key: string): VoiceDependencies["persistence"] {
  async function transaction<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("t3-voice-outbox", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("calls");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new Error("Cannot open local call storage. Microphone audio will not be sent."));
    });
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = database.transaction("calls", mode);
        const request = operation(tx.objectStore("calls"));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = tx.onabort = () =>
          reject(
            new Error(
              "Local call storage failed. Keep this page open and free storage before retrying.",
            ),
          );
      });
    } finally {
      database.close();
    }
  }
  return {
    read: () =>
      transaction("readonly", (store) => store.get(key) as IDBRequest<SavedCall | undefined>),
    write: async (call) => {
      await transaction("readwrite", (store) => store.put(call, key));
    },
    clear: async () => {
      await transaction("readwrite", (store) => store.delete(key));
    },
  };
}
