import {
  Fragment,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  canEdit,
  fieldsOf,
  groups,
  labelOf,
  newEntity,
  search,
  sortGroups,
  type Entity,
} from "./model";
import { markdown, type Mark } from "./markdown";
import { DocumentStore } from "./store";
import { fieldKey, usePresence, type PresenceOptions } from "./presence";
import type { Identity } from "./identity";
const MenuContext = createContext<{
  open: string | null;
  setOpen: (key: string | null) => void;
}>({ open: null, setOpen: () => {} });
function Menu({
  id,
  label,
  children,
  className = "",
  ariaLabel,
  presenceKey,
  disabled = false,
}: {
  disabled?: boolean;
  id: string;
  label: ReactNode;
  children: ReactNode;
  className?: string;
  ariaLabel: string;
  presenceKey?: string;
}) {
  const { open, setOpen } = useContext(MenuContext);
  return (
    <span
      className={`dv-picker ${className}`}
      data-menu={id}
      data-presence-field={presenceKey}
    >
      <button
        type="button"
        className="dv-trigger"
        aria-label={ariaLabel}
        aria-expanded={open === id}
        disabled={disabled}
        onClick={() => setOpen(open === id ? null : id)}
      >
        {label}
      </button>
      {open === id && (
        <span className="dv-menu" role="group" aria-label={ariaLabel}>
          {children}
        </span>
      )}
    </span>
  );
}
const tags = {
  p: "div",
  strong: "strong",
  em: "em",
  code: "code",
  h: "div",
  li: "div",
};
function markNodes(marks: Mark[]): Node[] {
  return marks.map((m) => {
    if (typeof m === "string") return document.createTextNode(m);
    const el = document.createElement(m.tag === "a" ? "a" : tags[m.tag]);
    if (m.tag === "a") {
      el.setAttribute("href", m.href!);
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    } else if (m.tag === "p" || m.tag === "h" || m.tag === "li") {
      el.className = `dv-md-${m.tag}`;
      if (m.marker) el.dataset.marker = m.marker;
    }
    el.append(...markNodes(m.children));
    return el;
  });
}
export function EditableText({
  value,
  onChange,
  onEmpty,
  label,
  presenceKey,
  multiline = false,
  placeholder,
  readOnly = false,
}: {
  // Shown as it is at rest, and cannot be edited.
  readOnly?: boolean;
  value: string;
  onChange: (value: string, before: string) => void;
  onEmpty?: () => void;
  label: string;
  presenceKey?: string;
  // Multiline text keeps line breaks and may be cleared.
  multiline?: boolean;
  placeholder?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null),
    initial = useRef(value),
    previous = useRef(value),
    latest = useRef(value),
    shown = useRef<string | null>(null),
    composing = useRef(false);
  latest.current = value;
  // At rest, multiline text shows its markdown; while edited it is the raw text.
  const show = (el: HTMLSpanElement, text: string) => {
    if (multiline) el.replaceChildren(...markNodes(markdown(text)));
    else el.textContent = text;
    shown.current = text;
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && el.contentEditable === "false" && shown.current !== value)
      show(el, value);
  }, [value]);
  // Browsers keep a trailing line break in an editable block; it is not content.
  const read = (el: HTMLSpanElement) => {
    const text = el.textContent ?? "";
    return multiline ? (text.trim() ? text.replace(/\n$/, "") : "") : text;
  };
  const onLink = (e: { target: EventTarget }) =>
    e.target instanceof Element && Boolean(e.target.closest("a"));
  const activate = (el: HTMLSpanElement) => {
    if (el.contentEditable === "false" && !readOnly) {
      previous.current = shown.current ?? value;
      if (multiline) el.textContent = previous.current;
      el.contentEditable = multiline ? "plaintext-only" : "true";
    }
  };
  const changed = (el: HTMLSpanElement) => {
    if (composing.current) return;
    const text = read(el);
    if (multiline && !text && el.firstChild) el.textContent = "";
    if (text.trim() || multiline) {
      onChange(text, previous.current);
      previous.current = text;
    }
  };
  return (
    <span
      ref={ref}
      className={multiline ? "dv-text dv-multiline" : "dv-text"}
      data-placeholder={readOnly ? undefined : placeholder}
      data-presence-field={presenceKey}
      tabIndex={readOnly ? undefined : 0}
      role="textbox"
      aria-readonly={readOnly || undefined}
      aria-label={label}
      contentEditable={false}
      suppressContentEditableWarning
      onClick={(e) => {
        // A link at rest opens; anywhere else starts editing.
        if (e.currentTarget.contentEditable === "false" && onLink(e)) return;
        activate(e.currentTarget);
        e.currentTarget.focus();
      }}
      onPointerDown={(e) => {
        if (e.button === 0 && !onLink(e)) activate(e.currentTarget);
      }}
      onFocus={(e) => {
        const el = e.currentTarget;
        activate(el);
        // Focus from the keyboard or a menu has no caret yet; a click places its own.
        const s = window.getSelection();
        if (s && !(s.anchorNode && el.contains(s.anchorNode))) {
          s.selectAllChildren(el);
          s.collapseToEnd();
        }
      }}
      onInput={(e) => changed(e.currentTarget)}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={(e) => {
        composing.current = false;
        changed(e.currentTarget);
      }}
      onBlur={(e) => {
        const el = e.currentTarget;
        el.contentEditable = "false";
        if (!el.textContent?.trim() && onEmpty) onEmpty();
        else show(el, latest.current);
        const s = window.getSelection();
        if (s?.anchorNode && el.contains(s.anchorNode)) s.removeAllRanges();
      }}
      onKeyDown={(e) => {
        if (
          ((e.key === "Enter" && !multiline) || e.key === "Escape") &&
          !e.nativeEvent.isComposing
        ) {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      onPaste={(e) => {
        e.preventDefault();
        document.execCommand(
          "insertText",
          false,
          multiline
            ? e.clipboardData.getData("text/plain")
            : e.clipboardData.getData("text/plain").replace(/\n/g, " "),
        );
      }}
    >
      {initial.current}
    </span>
  );
}
// The one entry on the page that is open: shown in full, or being edited.
const OpenEntry = createContext<{
  entry: string | null;
  setEntry: (entry: string | null) => void;
}>({ entry: null, setEntry: () => {} });
// Long text under a line. At rest it shows its first paragraph, up to five
// lines, with a control to show the rest; only the open entry shows it all.
function Note({ entry, children }: { entry: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const { entry: current, setEntry } = useContext(OpenEntry),
    open = current === entry;
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current,
      text = el?.firstElementChild;
    if (!el || !(text instanceof HTMLElement)) return;
    const measure = () => {
      // While edited the text is raw; keep the last answer until it is at rest.
      const first = text.querySelector(":scope > .dv-md-p");
      if (text.contentEditable !== "false" || !(first instanceof HTMLElement))
        return;
      setLong(
        first.nextElementSibling !== null ||
          first.offsetHeight >
            parseFloat(getComputedStyle(el).lineHeight) * 5 + 1,
      );
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(text);
    return () => watch.disconnect();
  }, []);
  return (
    <div className="dv-note">
      <div ref={ref} className={long && !open ? "dv-clamp" : undefined}>
        {children}
      </div>
      {long && (
        <button
          type="button"
          className="dv-more"
          aria-expanded={open}
          onClick={() => setEntry(open ? null : entry)}
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
// A line that does not exist yet. Typing searches the candidates; Enter adds the
// highlighted one, or creates a new entity with the typed name.
function DraftLine({
  noun,
  candidates,
  onCreate,
  onPick,
  onClose,
}: {
  noun: string;
  candidates: Entity[];
  onCreate: (name: string) => void;
  onPick: (row: Entity) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(""),
    [active, setActive] = useState(-1);
  const query = text.trim().toLowerCase();
  const matches = query
    ? candidates
        .filter((r) => String(r.name).toLowerCase().includes(query))
        .slice(0, 8)
    : [];
  const done = () => {
    setText("");
    setActive(-1);
  };
  return (
    <li className="dv-draft">
      <input
        autoFocus
        value={text}
        placeholder={
          candidates.length ? `New ${noun}, or search by name` : `New ${noun}`
        }
        aria-label={`Add ${noun}`}
        onChange={(e) => {
          setText(e.target.value);
          setActive(-1);
        }}
        onBlur={() => {
          if (!text.trim()) onClose();
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape") onClose();
          else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const n = matches.length + 1,
              step = e.key === "ArrowDown" ? 1 : n - 1;
            setActive(((active + 1 + step) % n) - 1);
          } else if (e.key === "Enter" && query) {
            if (matches[active]) onPick(matches[active]);
            else onCreate(text.trim());
            done();
          }
        }}
      />
      {query && candidates.length > 0 && (
        <span
          className="dv-menu"
          role="listbox"
          aria-label={`Matching ${noun}s`}
        >
          {matches.map((r, i) => (
            <button
              type="button"
              role="option"
              key={r.id}
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(r);
                done();
              }}
            >
              {String(r.name)}
            </button>
          ))}
          <button
            type="button"
            role="option"
            aria-selected={active === -1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onCreate(text.trim());
              done();
            }}
          >
            New {noun} “{text.trim()}”
          </button>
        </span>
      )}
    </li>
  );
}
// A person's picture, or their initials without one.
export function Avatar({ person }: { person: Entity }) {
  const name = String(person.short || person.name);
  return (
    <span className="dv-avatar" title={String(person.name)}>
      {person.image ? (
        <img src={String(person.image)} alt="" referrerPolicy="no-referrer" />
      ) : (
        name.slice(0, 2)
      )}
    </span>
  );
}
export function useDocument(store: DocumentStore) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  useEffect(() => store.start(), [store]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (store.getSnapshot().pending) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [store]);
  return state;
}
export type DocumentEditorProps = {
  store: DocumentStore;
  presence?: PresenceOptions;
  // Lets a visitor say which person they are; see createIdentity.
  identity?: Identity;
  // Shown before a related record's name. People get their avatar unless this
  // returns something else; return null for nothing.
  renderPrefix?: (type: string, entity: Entity) => ReactNode;
  // A related record's name where it is not editable. People use their short name.
  renderLabel?: (type: string, entity: Entity) => ReactNode;
};
export function DocumentEditor({
  store,
  renderPrefix: customPrefix,
  renderLabel,
  presence,
  identity,
}: DocumentEditorProps) {
  const state = useDocument(store),
    config = store.config;
  const [viewIndex, setView] = useState(0),
    [open, setOpen] = useState<string | null>(null),
    [draft, setDraft] = useState<string | null>(null),
    [entry, setEntry] = useState<string | null>(null),
    [query, setQuery] = useState("");
  const root = useRef<HTMLElement>(null);
  // Sorting uses the stamp a record had when first seen here, so a line does
  // not move while it is being edited. Reloading re-sorts.
  const stamps = useRef(new Map<string, string | undefined>());
  const stamp = (type: string, id: string) => {
    const key = `${type}:${id}`;
    if (!stamps.current.has(key))
      stamps.current.set(
        key,
        state.data[type]?.find((r) => r.id === id)?.modified,
      );
    return stamps.current.get(key);
  };
  // The first collection of people is who a visitor can be.
  const people = Object.keys(config.collections).find(
    (type) => config.collections[type].kind === "person",
  );
  const claimed = useSyncExternalStore(
    identity?.subscribe ?? (() => () => {}),
    () => identity?.get(),
    () => undefined,
  );
  const everyone = (people && state.data[people]) || [];
  const me = everyone.find((r) => r.id === claimed);
  const others = usePresence(root, presence, {
    me: me?.id,
    face: (id) => {
      const row = everyone.find((r) => r.id === id);
      return (
        row && {
          name: String(row.short || row.name),
          image: String(row.image ?? "") || undefined,
        }
      );
    },
  });
  useEffect(() => {
    const outside = (e: Event) => {
      const target = e.target;
      const focused = document.activeElement;
      if (
        e.type === "pointerdown" &&
        focused instanceof HTMLElement &&
        focused.isContentEditable &&
        target instanceof Node &&
        !focused.contains(target)
      )
        focused.blur();
      if (
        !(target instanceof Element) ||
        !root.current?.contains(target) ||
        !target.closest("[data-menu]")
      )
        setOpen(null);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (open) {
        e.preventDefault();
        const trigger = root.current?.querySelector<HTMLButtonElement>(
          '[aria-expanded="true"]',
        );
        setOpen(null);
        trigger?.focus();
      } else if (
        document.activeElement instanceof HTMLElement &&
        root.current?.contains(document.activeElement)
      ) {
        document.activeElement.blur();
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  const person = (type: string) => config.collections[type].kind === "person";
  const renderPrefix = (type: string, row: Entity) => {
    const custom = customPrefix?.(type, row);
    return custom === undefined && person(type) ? (
      <Avatar person={row} />
    ) : (
      custom
    );
  };
  const view = config.views[viewIndex],
    main = fieldsOf(config, config.main);
  // A view groups by a field of the collection, by another collection's
  // relationship to it (reverse), or not at all.
  const reverse = typeof view.groupBy === "object" ? view.groupBy : null,
    groupField = typeof view.groupBy === "string" ? view.groupBy : null,
    descriptor = groupField ? main[groupField] : undefined;
  const groupType = reverse
    ? reverse.collection
    : descriptor?.type === "many"
      ? descriptor.of
      : null;
  const arranged = search(
    config,
    state.data,
    sortGroups(
      view,
      groups(config, state.data, view.groupBy),
      stamp,
      config.main,
    ),
    query,
  );
  const noun = (type: string) => labelOf(config, type);
  const fixed = (type: string) => config.collections[type].fixed ?? false;
  // A record with owners can be changed only by one of them.
  const can = (type: string, row: Entity) => canEdit(config, type, row, me?.id);
  const text = (type: string, row: Entity, field = "name") =>
    fixed(type) ? (
      <span>{String(row[field])}</span>
    ) : (
      <EditableText
        readOnly={!can(type, row)}
        presenceKey={fieldKey(type, row.id, field)}
        value={String(row[field])}
        label={`${noun(type)} ${field}`}
        onChange={(v, b) => store.set(type, row.id, field, v, b)}
        onEmpty={
          field === "name" ? () => store.remove(type, row.id) : undefined
        }
      />
    );
  const memberOf = (row: Entity, related: Entity) =>
    reverse
      ? (related[reverse.field] as string[]).includes(row.id)
      : (row[groupField!] as string[]).includes(related.id);
  function setMember(row: Entity, related: Entity, member: boolean) {
    const [type, owner, field, id] = reverse
      ? [reverse.collection, related, reverse.field, row.id]
      : [config.main, row, groupField!, related.id];
    store.link(type, owner.id, field, id, member);
  }
  const label = (type: string, row: Entity) =>
    renderLabel?.(type, row) ?? String((person(type) && row.short) || row.name);
  function add(type: string, group?: string, name?: string) {
    const row = newEntity(config, type, crypto.randomUUID());
    if (name) row.name = name;
    if (type === config.main && group && groupField) {
      row[groupField] = descriptor?.type === "many" ? [group] : group;
    }
    store.create(type, row);
    const owner =
      type === config.main && group && reverse
        ? state.data[reverse.collection].find((r) => r.id === group)
        : undefined;
    if (owner && reverse)
      store.link(reverse.collection, owner.id, reverse.field, row.id);
  }
  function field(row: Entity, name: string, occurrence: string) {
    const d = main[name],
      value = row[name];
    if (d.type === "text" || d.type === "longtext")
      return text(config.main, row, name);
    const colors = (choice: string) =>
      (d.type === "choice" &&
        d.options.find((o) => o.name === choice)?.color) ||
      "#999";
    if (d.type === "choice")
      return (
        <Menu
          presenceKey={fieldKey(config.main, row.id, name)}
          id={`${occurrence}:${name}`}
          ariaLabel={`${name} for ${row.name}`}
          disabled={!can(config.main, row)}
          className={d.bullet ? "dv-bullet" : ""}
          label={
            d.bullet ? (
              <i
                className="dv-dot"
                style={{ background: colors(String(value)) }}
              />
            ) : (
              String(value)
            )
          }
        >
          {d.options.map(({ name: choice }) => (
            <button
              type="button"
              key={choice}
              aria-pressed={choice === value}
              onClick={() => {
                store.set(config.main, row.id, name, choice);
                setOpen(null);
              }}
            >
              <i className="dv-dot" style={{ background: colors(choice) }} />
              {choice}
              {choice === value ? " ✓" : ""}
            </button>
          ))}
        </Menu>
      );
    if (d.type !== "many") return null;
    const members = state.data[d.of].filter((r) =>
      (value as string[]).includes(r.id),
    );
    if (name === groupField && d.summary) return null;
    return (
      <Menu
        presenceKey={fieldKey(config.main, row.id, name)}
        id={`${occurrence}:${name}`}
        ariaLabel={`${name} for ${row.name}`}
        disabled={!can(config.main, row)}
        className={d.summary ? "dv-count" : ""}
        label={
          d.summary
            ? `${members.length} ${d.label ?? noun(d.of)}${members.length === 1 ? "" : "s"}`
            : members.length
              ? members.map((r) => (
                  <span className="dv-member" key={r.id}>
                    {renderPrefix(d.of, r)}
                    {label(d.of, r)}
                  </span>
                ))
              : `No ${d.label ?? noun(d.of)}`
        }
      >
        {state.data[d.of].map((r) => (
          <span className="dv-option" key={r.id}>
            <input
              type="checkbox"
              aria-label={`Include ${r.name}`}
              checked={(value as string[]).includes(r.id)}
              onChange={(e) =>
                store.link(config.main, row.id, name, r.id, e.target.checked)
              }
            />
            {renderPrefix(d.of, r)}
            {text(d.of, r)}
          </span>
        ))}
      </Menu>
    );
  }
  const groupControl =
    groupType && !fixed(groupType) ? (
      <button className="dv-add-group" onClick={() => add(groupType)}>
        + Add a {noun(groupType)}
      </button>
    ) : null;
  const statusText =
    state.status === "saved" ? "All changes saved" : state.status;
  return (
    <MenuContext.Provider value={{ open, setOpen }}>
      <OpenEntry.Provider value={{ entry, setEntry }}>
        <main
          className={
            config.line.some((name) => main[name].type === "longtext")
              ? "dv-document dv-blocks"
              : "dv-document"
          }
          ref={root}
        >
          <header>
            <h1>{config.title}</h1>
            <span
              className="dv-save"
              role="status"
              title={state.error || statusText}
              aria-label={state.error || statusText}
            >
              {state.status === "saved"
                ? "✓"
                : state.status === "saving"
                  ? "◌"
                  : state.status === "connecting"
                    ? "◌"
                    : "!"}
            </span>
            <span className="dv-presence-count" role="status">
              {others > 0
                ? `${others} ${others === 1 ? "other" : "others"} here`
                : ""}
            </span>
            {identity && people && (
              <Menu
                id="me"
                className="dv-me"
                ariaLabel="Who you are"
                label={
                  me ? (
                    <>
                      {renderPrefix(people, me)}
                      {label(people, me)}
                    </>
                  ) : (
                    "Who are you?"
                  )
                }
              >
                {everyone.map((r) => (
                  <button
                    type="button"
                    key={r.id}
                    aria-pressed={r.id === me?.id}
                    onClick={() => {
                      identity.set(r.id);
                      setOpen(null);
                    }}
                  >
                    {renderPrefix(people, r)}
                    {String(r.name)}
                    {r.id === me?.id ? " ✓" : ""}
                  </button>
                ))}
                {me && (
                  <button
                    type="button"
                    onClick={() => {
                      identity.set(undefined);
                      setOpen(null);
                    }}
                  >
                    Not me
                  </button>
                )}
              </Menu>
            )}
            <nav aria-label="Group document">
              {config.views.map((v, i) => (
                <button
                  key={i}
                  aria-pressed={viewIndex === i}
                  onClick={() => {
                    setOpen(null);
                    setDraft(null);
                    setEntry(null);
                    setView(i);
                  }}
                >
                  {v.label}
                </button>
              ))}
            </nav>
            {config.search && (
              <input
                className="dv-search"
                type="search"
                value={query}
                placeholder={`Search ${noun(config.main)}s`}
                aria-label={`Search ${noun(config.main)}s`}
                onChange={(e) => setQuery(e.target.value)}
              />
            )}
          </header>
          {!state.realtime && (
            <div className="dv-connection" role="status">
              Live updates reconnecting.{" "}
              {state.pending
                ? "Changes waiting to save."
                : state.status === "saved"
                  ? "All changes saved."
                  : "Checking saved changes."}
            </div>
          )}
          {state.storageError && (
            <div className="dv-error" role="alert">
              {state.storageError}
            </div>
          )}
          {state.error && (
            <div className="dv-error" role="alert">
              {state.pending > 0 && state.status !== "conflict"
                ? "Changes not yet saved. "
                : ""}
              {state.error}{" "}
              {state.status === "conflict" ? (
                <>
                  <button
                    onClick={() => {
                      const blob = new Blob(
                        [JSON.stringify(store.exportDraft(), null, 2)],
                        { type: "application/json" },
                      );
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = "document-draft.json";
                      a.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    }}
                  >
                    Download my draft
                  </button>{" "}
                  <button onClick={store.useRemote}>Use shared version</button>
                </>
              ) : (
                <button onClick={store.retry}>Retry</button>
              )}
            </div>
          )}
          {query.trim() && !arranged.length && (
            <p className="dv-empty">No {noun(config.main)}s match.</p>
          )}
          {arranged.map((group) => (
            <Fragment key={`${viewIndex}:${group.id}`}>
              {!group.id && groupControl}
              <section>
                <h2 hidden={view.groupBy === undefined}>
                  {group.type
                    ? (() => {
                        const row = state.data[group.type].find(
                          (r) => r.id === group.id,
                        )!;
                        return (
                          <>
                            {renderPrefix(group.type, row)}
                            {text(group.type, row)}
                          </>
                        );
                      })()
                    : group.name}
                </h2>
                <ul>
                  {group.rows.map((row) => {
                    const occurrence = `${viewIndex}:${group.id}:${row.id}`;
                    const colored = Object.entries(main).find(
                      ([, d]) => d.type === "choice" && d.bullet,
                    );
                    const color =
                      colored?.[1].type === "choice"
                        ? colored[1].options.find(
                            (o) => o.name === row[colored[0]],
                          )?.color
                        : undefined;
                    return (
                      <li
                        key={row.id}
                        // Editing an entry opens it, which closes any other.
                        onFocus={(e) => {
                          if (!e.target.closest(".dv-more"))
                            setEntry(occurrence);
                        }}
                      >
                        {colored && field(row, colored[0], occurrence)}
                        {config.line
                          .filter(
                            (name) =>
                              name !== colored?.[0] &&
                              name !== groupField &&
                              main[name].type !== "longtext",
                          )
                          .map((name, i) => (
                            <Fragment key={name}>
                              {i === 1 &&
                                !(
                                  main[name].type === "many" &&
                                  main[name].summary
                                ) && <span className="dv-separator"> — </span>}
                              <span
                                style={
                                  main[name].type === "text"
                                    ? { color }
                                    : undefined
                                }
                              >
                                {field(row, name, occurrence)}
                              </span>
                            </Fragment>
                          ))}
                        {config.line
                          .filter((name) => main[name].type === "longtext")
                          .map((name) => (
                            <Note key={name} entry={occurrence}>
                              <EditableText
                                multiline
                                readOnly={!can(config.main, row)}
                                placeholder={`Add ${name}`}
                                presenceKey={fieldKey(
                                  config.main,
                                  row.id,
                                  name,
                                )}
                                value={String(row[name])}
                                label={`${noun(config.main)} ${name}`}
                                onChange={(v, b) =>
                                  store.set(config.main, row.id, name, v, b)
                                }
                              />
                            </Note>
                          ))}
                        <Menu
                          id={`${occurrence}:actions`}
                          className="dv-actions"
                          ariaLabel={`Options for ${row.name}`}
                          label="···"
                        >
                          {groupType && (
                            <>
                              <span className="dv-menu-title">
                                {view.label}
                              </span>
                              {state.data[groupType].map((related) => (
                                <label className="dv-option" key={related.id}>
                                  <input
                                    type="checkbox"
                                    checked={memberOf(row, related)}
                                    disabled={
                                      reverse
                                        ? !can(reverse.collection, related)
                                        : !can(config.main, row)
                                    }
                                    onChange={(e) =>
                                      setMember(row, related, e.target.checked)
                                    }
                                  />
                                  {String(related.name)}
                                </label>
                              ))}
                            </>
                          )}
                          <button
                            hidden={!can(config.main, row)}
                            onClick={() => {
                              store.remove(config.main, row.id);
                              setOpen(null);
                            }}
                          >
                            Remove {noun(config.main)}
                          </button>
                        </Menu>
                      </li>
                    );
                  })}
                  {draft === `${viewIndex}:${group.id}` && (
                    <DraftLine
                      noun={noun(config.main)}
                      candidates={
                        groupType && group.id
                          ? state.data[config.main].filter(
                              (r) => !group.rows.includes(r),
                            )
                          : []
                      }
                      onCreate={(name) => add(config.main, group.id, name)}
                      onPick={(row) => {
                        const related = state.data[groupType!].find(
                          (r) => r.id === group.id,
                        );
                        if (related) setMember(row, related, true);
                      }}
                      onClose={() => setDraft(null)}
                    />
                  )}
                </ul>
                <button
                  className="dv-add-line"
                  aria-label={`Add ${noun(config.main)}${group.name ? ` under ${group.name}` : ""}`}
                  title="Add a line"
                  hidden={draft === `${viewIndex}:${group.id}`}
                  onClick={() => setDraft(`${viewIndex}:${group.id}`)}
                >
                  ·
                </button>
              </section>
            </Fragment>
          ))}
          {!arranged.some((g) => !g.id) && groupControl}
        </main>
      </OpenEntry.Provider>
    </MenuContext.Provider>
  );
}
