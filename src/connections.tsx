import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Data, Entity } from "./model";

export type ConnectionStrength =
  "Primary" | "Supporting" | "Enabling" | "Unmapped";
export type ConnectionViewOptions = {
  label?: string;
  groupCollection: string;
  memberField: string;
  goals: {
    id: string;
    label: string;
    title: string;
    projects?: Record<string, ConnectionStrength>;
    projectField?: string;
  }[];
};
export function connectionStrength(
  goal: ConnectionViewOptions["goals"][number],
  project: Entity,
): ConnectionStrength {
  const value = goal.projectField
    ? project[goal.projectField]
    : goal.projects?.[project.id];
  return value === "Primary" || value === "Supporting" || value === "Enabling"
    ? value
    : "Unmapped";
}
type Selection = { type: "goal" | "project" | "entry"; id: string } | null;
type Props = {
  options: ConnectionViewOptions;
  data: Data;
  main: string;
  entryLabel: string;
  groupLabel: string;
  readOnly: boolean;
  entryFixed: boolean;
  groupFixed: boolean;
  fields: string[];
  renderName(type: string, row: Entity): ReactNode;
  renderField(row: Entity, name: string): ReactNode;
  canEdit(type: string, row: Entity): boolean;
  onRemove(type: string, id: string): void;
  onSetConnection(row: Entity, field: string, value: ConnectionStrength): void;
  onCreate(type: string, name: string, project?: string): string;
};
const members = (row: Entity, field: string): string[] =>
  Array.isArray(row[field]) ? (row[field] as string[]) : [];

function AddRecord({
  label,
  onAdd,
}: {
  label: string;
  onAdd(name: string): void;
}) {
  const [name, setName] = useState("");
  return (
    <form
      className="dv-band-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onAdd(name.trim());
        setName("");
      }}
    >
      <input
        aria-label={`New ${label} name`}
        placeholder={`New ${label}`}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit" disabled={!name.trim()}>
        Add
      </button>
    </form>
  );
}

export function ConnectionEditor({
  options,
  data,
  main,
  entryLabel,
  groupLabel,
  readOnly,
  entryFixed,
  groupFixed,
  fields,
  renderName,
  renderField,
  canEdit,
  onRemove,
  onSetConnection,
  onCreate,
}: Props) {
  const projects = data[options.groupCollection] ?? [],
    entries = data[main] ?? [];
  const [selection, setSelection] = useState<Selection>(() =>
    projects[0] ? { type: "project", id: projects[0].id } : null,
  );
  const [paths, setPaths] = useState<
    { d: string; strength: string; active: boolean }[]
  >([]);
  const stage = useRef<HTMLDivElement>(null);
  const suppress = useRef(false);
  const drag = useRef<{
    node: HTMLElement;
    x: number;
    y: number;
    id: number;
    moved: boolean;
  } | null>(null);
  const redraw = useRef(() => {});
  const activeProjects = new Set<string>(),
    activeGoals = new Set<string>(),
    activeEntries = new Set<string>();
  if (!selection) {
    projects.forEach((p) => activeProjects.add(p.id));
    options.goals.forEach((g) => activeGoals.add(g.id));
    entries.forEach((e) => activeEntries.add(e.id));
  } else {
    if (selection.type === "project") activeProjects.add(selection.id);
    if (selection.type === "goal") {
      const goal = options.goals.find((g) => g.id === selection.id);
      projects.forEach((p) => {
        const strength = goal ? connectionStrength(goal, p) : "Unmapped";
        if (strength && strength !== "Unmapped") activeProjects.add(p.id);
      });
    }
    if (selection.type === "entry")
      entries.find((e) => e.id === selection.id) &&
        members(
          entries.find((e) => e.id === selection.id)!,
          options.memberField,
        ).forEach((id) => activeProjects.add(id));
    options.goals.forEach((g) => {
      if (
        projects.some(
          (p) =>
            activeProjects.has(p.id) && connectionStrength(g, p) !== "Unmapped",
        )
      )
        activeGoals.add(g.id);
    });
    entries.forEach((e) => {
      if (members(e, options.memberField).some((id) => activeProjects.has(id)))
        activeEntries.add(e.id);
    });
    if (selection.type === "goal") {
      activeGoals.clear();
      activeGoals.add(selection.id);
    }
    if (selection.type === "entry") {
      activeEntries.clear();
      activeEntries.add(selection.id);
    }
  }
  const selectedProject =
    selection?.type === "project"
      ? projects.find((p) => p.id === selection.id)
      : undefined;
  const sortedEntries = [...entries].sort(
    (a, b) =>
      Number(activeEntries.has(b.id)) - Number(activeEntries.has(a.id)) ||
      String(a.name).localeCompare(String(b.name)),
  );
  const choose = (type: NonNullable<Selection>["type"], id: string) => {
    if (!suppress.current) setSelection({ type, id });
  };
  const className = (
    type: NonNullable<Selection>["type"],
    id: string,
    related: boolean,
  ) =>
    `dv-band-node${selection?.type === type && selection.id === id ? " selected" : related ? " related" : " dim"}`;
  useEffect(() => {
    if (
      selection &&
      ((selection.type === "project" &&
        !projects.some((p) => p.id === selection.id)) ||
        (selection.type === "entry" &&
          !entries.some((e) => e.id === selection.id)))
    )
      setSelection(null);
  }, [data, selection, projects, entries]);

  useLayoutEffect(() => {
    const root = stage.current!;
    let raf = 0;
    const draw = () => {
      const box = root.getBoundingClientRect();
      const nodes = new Map<
        string,
        { x: number; right: number; y: number; visible: boolean }
      >();
      root.querySelectorAll<HTMLElement>("[data-band-node]").forEach((el) => {
        const rect = el.getBoundingClientRect(),
          list = el.closest(".dv-band-list")!.getBoundingClientRect();
        nodes.set(el.dataset.bandNode!, {
          x: rect.left - box.left,
          right: rect.right - box.left,
          y: rect.top + rect.height / 2 - box.top,
          visible:
            rect.top + rect.height / 2 >= list.top &&
            rect.top + rect.height / 2 <= list.bottom,
        });
      });
      const next: typeof paths = [];
      const connect = (
        from: string,
        to: string,
        strength: string,
        active: boolean,
      ) => {
        const a = nodes.get(from),
          b = nodes.get(to);
        if (!a?.visible || !b?.visible) return;
        const control = Math.max(35, (b.x - a.right) * 0.55);
        next.push({
          d: `M ${a.right} ${a.y} C ${a.right + control} ${a.y}, ${b.x - control} ${b.y}, ${b.x} ${b.y}`,
          strength,
          active,
        });
      };
      projects.forEach((p) => {
        options.goals.forEach((g) => {
          const strength = connectionStrength(g, p);
          if (strength && strength !== "Unmapped")
            connect(
              `goal:${g.id}`,
              `project:${p.id}`,
              strength,
              activeProjects.has(p.id) && activeGoals.has(g.id),
            );
        });
        entries.forEach((e) => {
          if (members(e, options.memberField).includes(p.id))
            connect(
              `project:${p.id}`,
              `entry:${e.id}`,
              "Supporting",
              activeProjects.has(p.id) && activeEntries.has(e.id),
            );
        });
      });
      setPaths(next);
    };
    const schedule = () => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          draw();
        });
    };
    redraw.current = schedule;
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    root
      .querySelectorAll("[data-band-node]")
      .forEach((el) => observer.observe(el));
    root.addEventListener("scroll", schedule, true);
    draw();
    return () => {
      observer.disconnect();
      root.removeEventListener("scroll", schedule, true);
      cancelAnimationFrame(raf);
    };
  }, [data, options, selection]);

  const release = () => {
    if (!drag.current) return;
    const { node, moved } = drag.current;
    drag.current = null;
    if (!moved) return;
    suppress.current = true;
    node.classList.remove("dragging");
    node.classList.add("returning");
    node.style.transform = "";
    const until = performance.now() + 500;
    const animate = () => {
      redraw.current();
      if (performance.now() < until && node.isConnected)
        requestAnimationFrame(animate);
      else node.classList.remove("returning");
    };
    animate();
    setTimeout(() => {
      suppress.current = false;
    }, 60);
  };
  return (
    <div className="dv-band-view">
      <div className="dv-band-toolbar">
        <span>
          Select a node to trace connections. Drag its handle to stretch the
          bands.
        </span>
        <button onClick={() => setSelection(null)}>Clear selection</button>
      </div>
      <div className="dv-band-scroll">
        <div
          className="dv-band-stage"
          ref={stage}
          onPointerDown={(e) => {
            const handle = (e.target as Element).closest("[data-band-handle]");
            if (!handle || e.button !== 0 || e.pointerType === "touch") return;
            const node = handle.closest<HTMLElement>("[data-band-node]")!;
            drag.current = {
              node,
              x: e.clientX,
              y: e.clientY,
              id: e.pointerId,
              moved: false,
            };
            handle.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d || e.pointerId !== d.id) return;
            const x = e.clientX - d.x,
              y = e.clientY - d.y;
            if (!d.moved && Math.hypot(x, y) < 4) return;
            d.moved = true;
            d.node.classList.add("dragging");
            d.node.style.transform = `translate(${Math.tanh(x / 100) * 50}px,${Math.tanh(y / 100) * 65}px)`;
            redraw.current();
          }}
          onPointerUp={release}
          onPointerCancel={release}
        >
          <svg className="dv-band-lines" aria-hidden="true">
            {paths.map((p, i) => (
              <path
                key={i}
                d={p.d}
                fill="none"
                stroke={p.strength === "Primary" ? "#333" : "#999"}
                strokeWidth={
                  p.active
                    ? p.strength === "Primary"
                      ? 4
                      : p.strength === "Enabling"
                        ? 1.5
                        : 2.5
                    : 1
                }
                opacity={p.active ? 0.65 : 0.08}
              />
            ))}
          </svg>
          <div className="dv-band-column">
            <h2>Goals</h2>
            <div className="dv-band-list">
              {options.goals.map((g) => (
                <div
                  key={g.id}
                  data-band-node={`goal:${g.id}`}
                  className={className("goal", g.id, activeGoals.has(g.id))}
                >
                  <button
                    className="dv-band-select"
                    data-band-handle
                    onClick={() => choose("goal", g.id)}
                    aria-pressed={
                      selection?.type === "goal" && selection.id === g.id
                    }
                  >
                    <strong>{g.label}</strong>
                    <small>{g.title}</small>
                  </button>
                </div>
              ))}
            </div>
          </div>
          <div className="dv-band-column">
            <h2>{groupLabel[0].toUpperCase() + groupLabel.slice(1)}s</h2>
            <div className="dv-band-list">
              {projects.map((p) => (
                <div
                  key={p.id}
                  data-band-node={`project:${p.id}`}
                  className={className(
                    "project",
                    p.id,
                    activeProjects.has(p.id),
                  )}
                >
                  <button
                    className="dv-band-handle"
                    data-band-handle
                    aria-label={`Trace ${p.name}`}
                    aria-pressed={
                      selection?.type === "project" && selection.id === p.id
                    }
                    onClick={() => choose("project", p.id)}
                  >
                    ↗
                  </button>
                  <div className="dv-band-name">
                    {renderName(options.groupCollection, p)}
                  </div>
                  {selection?.type === "project" && selection.id === p.id && (
                    <div
                      className="dv-band-goal-controls"
                      aria-label={`Goal contributions for ${p.name}`}
                    >
                      {options.goals
                        .filter((g) => g.projectField)
                        .map((g) => (
                          <label key={g.id}>
                            <span>{g.label}</span>
                            <select
                              aria-label={`${g.label} contribution for ${p.name}`}
                              value={connectionStrength(g, p)}
                              disabled={!canEdit(options.groupCollection, p)}
                              onChange={(e) =>
                                onSetConnection(
                                  p,
                                  g.projectField!,
                                  e.target.value as ConnectionStrength,
                                )
                              }
                            >
                              <option value="Unmapped">None</option>
                              <option>Primary</option>
                              <option>Supporting</option>
                              <option>Enabling</option>
                            </select>
                          </label>
                        ))}
                    </div>
                  )}
                  {selection?.type === "project" &&
                    selection.id === p.id &&
                    !groupFixed &&
                    canEdit(options.groupCollection, p) && (
                      <button
                        className="dv-band-remove"
                        onClick={() => onRemove(options.groupCollection, p.id)}
                      >
                        Remove {groupLabel}
                      </button>
                    )}
                </div>
              ))}
            </div>
            {!readOnly && !groupFixed && (
              <AddRecord
                label={groupLabel}
                onAdd={(name) =>
                  setSelection({
                    type: "project",
                    id: onCreate(options.groupCollection, name),
                  })
                }
              />
            )}
          </div>
          <div className="dv-band-column">
            <h2>
              {entryLabel[0].toUpperCase() + entryLabel.slice(1)}s ·{" "}
              {entries.length}
            </h2>
            <div className="dv-band-list">
              {sortedEntries.map((e) => (
                <div
                  key={e.id}
                  data-band-node={`entry:${e.id}`}
                  className={className("entry", e.id, activeEntries.has(e.id))}
                >
                  <button
                    className="dv-band-handle"
                    data-band-handle
                    aria-label={`Trace ${e.name}`}
                    aria-pressed={
                      selection?.type === "entry" && selection.id === e.id
                    }
                    onClick={() => choose("entry", e.id)}
                  >
                    ↗
                  </button>
                  <div className="dv-band-name">{renderName(main, e)}</div>
                  <div className="dv-band-fields">
                    {fields
                      .filter(
                        (f) =>
                          f !== options.memberField ||
                          (selection?.type === "entry" &&
                            selection.id === e.id),
                      )
                      .map((f) => (
                        <div className="dv-band-field" key={f}>
                          <span className="dv-band-field-label">{f}</span>
                          {renderField(e, f)}
                        </div>
                      ))}
                  </div>
                  {selection?.type === "entry" &&
                    selection.id === e.id &&
                    !entryFixed &&
                    canEdit(main, e) && (
                      <button
                        className="dv-band-remove"
                        onClick={() => onRemove(main, e.id)}
                      >
                        Remove {entryLabel}
                      </button>
                    )}
                </div>
              ))}
            </div>
            {!readOnly && !entryFixed && (
              <AddRecord
                label={entryLabel}
                onAdd={(name) =>
                  setSelection({
                    type: "entry",
                    id: onCreate(main, name, selectedProject?.id),
                  })
                }
              />
            )}
          </div>
        </div>
      </div>
      <div className="dv-band-legend">
        Black: primary · Grey: supporting · Thin grey: enabling
      </div>
    </div>
  );
}
