/**
 * Read and update the JSON documents kept by the Rust backend (`data.rs`).
 *
 * The model can call several tools in one turn, and two of them may update
 * the same document. `update` therefore runs changes to one document one at
 * a time, so a read-modify-write can never overwrite another change.
 */

export type DocumentName = "memory" | "profile" | "goals" | "protocols" | "settings" | "rules";

/** Thin wrapper over the `data_read` and `data_write` commands. */
export interface DocumentBackend {
  read(name: DocumentName): Promise<unknown | null>;
  write(name: DocumentName, value: unknown): Promise<void>;
}

export interface DocumentStore {
  read<T>(name: DocumentName): Promise<T | null>;
  /**
   * Applies `change` to the stored document and saves the result. Throws
   * (and saves nothing) when `change` throws.
   */
  update<T>(name: DocumentName, change: (current: T | null) => T): Promise<T>;
}

export function createDocumentStore(backend: DocumentBackend): DocumentStore {
  const queues = new Map<DocumentName, Promise<unknown>>();

  return {
    async read<T>(name: DocumentName): Promise<T | null> {
      return (await backend.read(name)) as T | null;
    },

    update<T>(name: DocumentName, change: (current: T | null) => T): Promise<T> {
      const previous = queues.get(name) ?? Promise.resolve();
      const run = previous.then(async () => {
        const current = (await backend.read(name)) as T | null;
        const updated = change(current);
        await backend.write(name, updated);
        return updated;
      });
      // A failed change must not block the changes queued after it.
      queues.set(
        name,
        run.catch(() => undefined),
      );
      return run;
    },
  };
}
