import {
  apply,
  canEdit,
  equal,
  titleAfter,
  validate,
  type Change,
  type Config,
  type Data,
  type Operation,
  type Snapshot,
  type Value,
} from "./model";
export type Transport = {
  read(): Promise<Snapshot>;
  // A committed write answers with its `change`; a conflict or a replayed
  // request answers with the current `snapshot`.
  commit(
    id: string,
    operations: Operation[],
  ): Promise<{
    snapshot?: Snapshot;
    change?: Omit<Change, "operations">;
    conflict?: string;
  }>;
  // Pages are sent each committed change, or a whole snapshot.
  subscribe(
    receive: (update: Snapshot | Change) => void,
    status: (online: boolean) => void,
  ): () => void;
};
export type DraftStorage = {
  load(): string | null;
  save(value: string): void;
  clear(): void;
};
export type State = Snapshot & {
  title: string;
  realtime: boolean;
  storageError: string;
  status: "connecting" | "saved" | "saving" | "offline" | "conflict" | "error";
  error: string;
  pending: number;
};
export class DocumentStore {
  private base: Snapshot;
  private queue: Operation[] = [];
  private batch: { id: string; ops: Operation[] } | null = null;
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private users = 0;
  private epoch = 0;
  private busy = false;
  private online = false;
  private blocked = false;
  private state: State;
  private storageError = "";
  // The person signed in here; decides which owned records they may change.
  me: () => string | undefined = () => undefined;
  // True while nobody is signed in to a document that needs it: nothing changes.
  readOnly: () => boolean = () => false;
  private may(type: string, id: string) {
    if (this.readOnly()) return false;
    return canEdit(
      this.config,
      type,
      this.state.data[type]?.find((r) => r.id === id),
      this.me(),
    );
  }
  constructor(
    readonly config: Config,
    initial: Snapshot,
    private transport: Transport,
    private storage?: DraftStorage,
  ) {
    validate(config, initial.data);
    this.base = initial;
    this.state = {
      ...initial,
      title: initial.title ?? config.title,
      status: "connecting",
      error: "",
      pending: 0,
      realtime: false,
      storageError: "",
    };
    try {
      const saved = storage?.load();
      if (saved) {
        const draft = JSON.parse(saved);
        if (draft.version !== 1 || !Array.isArray(draft.queue))
          throw Error("Invalid draft");
        validate(config, draft.base.data);
        validate(
          config,
          draft.queue.reduce(
            (d: Data, op: Operation) => apply(config, d, op),
            draft.base.data,
          ),
        );
        this.base = draft.base;
        this.queue = draft.queue;
        this.batch = draft.batch;
        this.blocked = draft.blocked;
        this.emit(
          this.blocked
            ? "conflict"
            : this.queue.length
              ? "saving"
              : "connecting",
          draft.error || "",
        );
      }
    } catch {
      this.storageError =
        "Could not restore the local draft. Keep this tab open and download your draft before reloading.";
      this.state.storageError = this.storageError;
    }
  }
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private persist(error = this.state.error) {
    if (!this.storage) return;
    try {
      if (this.queue.length)
        this.storage.save(
          JSON.stringify({
            version: 1,
            base: this.base,
            queue: this.queue,
            batch: this.batch,
            blocked: this.blocked,
            error,
          }),
        );
      else this.storage.clear();
      this.storageError = "";
    } catch {
      this.storageError =
        "Local draft backup failed. Keep this tab open until changes are saved.";
    }
  }
  private emit(status = this.state.status, error = this.state.error) {
    this.persist(error);
    const data = this.queue.reduce(
      (d, op) => apply(this.config, d, op),
      this.base.data,
    );
    this.state = {
      ...this.base,
      title: titleAfter(this.base.title ?? this.config.title, this.queue),
      data,
      status,
      error,
      pending: this.queue.length,
      realtime: this.online,
      storageError: this.storageError,
    };
    this.listeners.forEach((fn) => fn());
  }
  receive = (update: Snapshot | Change) => {
    if ("operations" in update) {
      // A gap means a change was missed: read the whole document again.
      if (!this.advance(update) && update.revision > this.base.revision)
        void this.transport.read().then(this.receive, () => {});
    } else if (update.revision >= this.base.revision) {
      this.base = update;
      this.emit(
        this.queue.length ? this.state.status : "saved",
        this.queue.length ? this.state.error : "",
      );
    }
  };
  // Apply the change that directly follows the base. False if it is not that one.
  private advance(change: Change) {
    if (change.revision !== this.base.revision + 1) return false;
    this.base = {
      data: change.operations.reduce(
        (d, op) => apply(this.config, d, op, change.at),
        this.base.data,
      ),
      revision: change.revision,
      title: titleAfter(
        this.base.title ?? this.config.title,
        change.operations,
      ),
    };
    this.emit(
      this.queue.length ? this.state.status : "saved",
      this.queue.length ? this.state.error : "",
    );
    return true;
  }
  start = () => {
    this.users++;
    if (this.users === 1) {
      const epoch = ++this.epoch;
      this.schedule(0);
      this.unsubscribe = this.transport.subscribe(
        (s) => {
          if (epoch === this.epoch) this.receive(s);
        },
        (online) => {
          if (epoch !== this.epoch) return;
          this.online = online;
          if (!online) {
            this.emit();
            this.schedule(0);
            return;
          }
          // Subscribe first, then refresh on every reconnect to cover missed notifications.
          void this.transport
            .read()
            .then((s) => {
              if (epoch !== this.epoch) return;
              this.receive(s);
              if (!this.blocked) {
                this.emit(this.queue.length ? "saving" : "saved", "");
                this.schedule(0);
              }
            })
            .catch((e) => {
              if (epoch === this.epoch) this.emit("error", String(e.message));
            });
        },
      );
    }
    return () => {
      if (--this.users === 0) {
        ++this.epoch;
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.online = false;
        clearTimeout(this.timer);
      }
    };
  };
  private schedule(ms = 250) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), ms);
  }
  private enqueue(op: Operation) {
    // Coalesce only edits that have not been sent. Preserve the first comparison value.
    const start = this.batch?.ops.length ?? 0;
    const previous = this.queue[this.queue.length - 1];
    if (
      op.kind === "set" &&
      this.queue.length > start &&
      previous?.kind === "set" &&
      previous.type === op.type &&
      previous.id === op.id &&
      previous.field === op.field
    )
      this.queue[this.queue.length - 1] = { ...op, before: previous.before };
    else if (
      op.kind === "title" &&
      this.queue.length > start &&
      previous?.kind === "title"
    )
      this.queue[this.queue.length - 1] = { ...op, before: previous.before };
    else this.queue.push(op);
    this.emit(this.blocked ? "conflict" : "saving");
    this.schedule();
  }
  set(type: string, id: string, field: string, value: Value, expected?: Value) {
    const row = this.state.data[type]?.find((r) => r.id === id);
    if (!row || equal(row[field], value) || !this.may(type, id)) return;
    const op: Operation = {
      kind: "set",
      type,
      id,
      field,
      before: expected ?? row[field],
      value,
    };
    validate(this.config, apply(this.config, this.state.data, op));
    this.enqueue(op);
  }
  create(type: string, value: import("./model").Entity) {
    if (this.readOnly()) return;
    const op: Operation = { kind: "create", type, id: value.id, value };
    validate(this.config, apply(this.config, this.state.data, op));
    this.enqueue(op);
  }
  setTitle(value: string, expected?: string) {
    if (
      this.readOnly() ||
      !value.trim() ||
      value.length > 500 ||
      value === this.state.title
    )
      return;
    this.enqueue({
      kind: "title",
      before: expected ?? this.state.title,
      value,
    });
  }
  // Add or remove one member of a relationship.
  link(type: string, id: string, field: string, member: string, on = true) {
    const row = this.state.data[type]?.find((r) => r.id === id);
    if (
      !row ||
      (row[field] as string[]).includes(member) === on ||
      !this.may(type, id)
    )
      return;
    const op: Operation = {
      kind: on ? "link" : "unlink",
      type,
      id,
      field,
      value: member,
    };
    validate(this.config, apply(this.config, this.state.data, op));
    this.enqueue(op);
  }
  remove(type: string, id: string) {
    const before = this.state.data[type]?.find((r) => r.id === id);
    if (before && this.may(type, id))
      this.enqueue({ kind: "delete", type, id, before });
  }
  async flush() {
    if (this.busy || this.blocked || !this.queue.length) return;
    this.busy = true;
    this.batch ??= { id: crypto.randomUUID(), ops: this.queue.slice() };
    const batch = this.batch;
    this.persist();
    try {
      const result = await this.transport.commit(batch.id, batch.ops);
      if (result.snapshot) this.receive(result.snapshot);
      // Our own change may already have arrived on the feed, or follow ones we missed.
      if (
        result.change &&
        result.change.revision > this.base.revision &&
        !this.advance({ ...result.change, operations: batch.ops })
      )
        this.receive(await this.transport.read());
      if (result.conflict) {
        this.blocked = true;
        this.emit("conflict", result.conflict);
        return;
      }
      this.queue.splice(0, batch.ops.length);
      this.batch = null;
      this.emit(this.queue.length ? "saving" : "saved", "");
    } catch (e) {
      this.emit("error", (e as Error).message);
    } finally {
      this.busy = false;
      if (this.queue.length && !this.blocked && this.users)
        this.schedule(this.state.status === "error" ? 3000 : 0);
    }
  }
  retry = async () => {
    if (this.blocked) return;
    try {
      this.receive(await this.transport.read());
      this.emit(this.queue.length ? "saving" : "saved", "");
      this.schedule(0);
    } catch (e) {
      this.emit("error", (e as Error).message);
    }
  };
  exportDraft = () => ({ data: this.state.data, operations: this.queue });
  // Conflict resolution is explicit. We never silently overwrite a concurrent field edit.
  useRemote = () => {
    if (this.busy) return;
    this.queue = [];
    this.batch = null;
    this.blocked = false;
    this.emit("saved", "");
  };
}
