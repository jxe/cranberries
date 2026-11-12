import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Data, Entity } from "./model";

export type ConnectionStrength = "Primary" | "Supporting" | "Unmapped";
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
  return value === "Primary" || value === "Supporting" ? value : "Unmapped";
}
type WireEnd = { type: "goal" | "project"; id: string };
type Wire = {
  source: WireEnd;
  startX: number;
  startY: number;
  x: number;
  y: number;
};
type TubeMenu = { goalId: string; projectId: string; x: number; y: number };
type BandPath = {
  d: string;
  strength: string;
  active: boolean;
  goalId?: string;
  projectId?: string;
};
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
  renderGroupActions(row: Entity): ReactNode;
  canEdit(type: string, row: Entity): boolean;
  onRemove(type: string, id: string): void;
  onSetConnection(row: Entity, field: string, value: ConnectionStrength): void;
  onCreate(type: string, name: string, project?: string): string;
};
const members = (row: Entity, field: string): string[] =>
  Array.isArray(row[field]) ? (row[field] as string[]) : [];

export function sortConnectionProjects(
  projects: Entity[],
  goal?: ConnectionViewOptions["goals"][number],
) {
  if (!goal) return projects;
  const rank = { Primary: 0, Supporting: 1, Unmapped: 2 };
  return [...projects].sort(
    (a, b) =>
      rank[connectionStrength(goal, a)] - rank[connectionStrength(goal, b)],
  );
}
function AddRecord({
  label,
  onAdd,
}: {
  label: string;
  onAdd(name: string): void;
}) {
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  if (!adding)
    return (
      <button
        className="dv-band-add-toggle"
        aria-label={`Add ${label}`}
        title={`Add ${label}`}
        onClick={() => setAdding(true)}
      >
        +
      </button>
    );
  return (
    <form
      className="dv-band-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onAdd(name.trim());
        setName("");
        setAdding(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          setName("");
          setAdding(false);
        }
      }}
      onBlur={(e) => {
        if (!name.trim() && !e.currentTarget.contains(e.relatedTarget))
          setAdding(false);
      }}
    >
      <input
        autoFocus
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
  renderGroupActions,
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
  const [paths, setPaths] = useState<BandPath[]>([]);
  const [tubeMenu, setTubeMenu] = useState<TubeMenu | null>(null);
  const [wire, setWire] = useState<Wire | null>(null);
  const wireRef = useRef<Wire | null>(null);
  const wirePointer = useRef<{
    id: number;
    moved: boolean;
    x: number;
    y: number;
  } | null>(null);
  const tubeMenuRef = useRef<HTMLDivElement>(null);
  const putWire = (next: Wire | null) => {
    wireRef.current = next;
    setWire(next);
  };
  const portEnd = (el: Element | null): WireEnd | null => {
    const node = el?.closest<HTMLElement>("[data-band-node]");
    const key = node?.dataset.bandNode;
    if (key?.startsWith("goal:")) return { type: "goal", id: key.slice(5) };
    if (key?.startsWith("project:"))
      return { type: "project", id: key.slice(8) };
    return null;
  };
  const editablePair = (a: WireEnd, b: WireEnd) => {
    if (a.type === b.type) return null;
    const goalId = a.type === "goal" ? a.id : b.id;
    const projectId = a.type === "project" ? a.id : b.id;
    const goal = options.goals.find((g) => g.id === goalId);
    const project = projects.find((p) => p.id === projectId);
    return goal?.projectField &&
      project &&
      canEdit(options.groupCollection, project)
      ? { goal, project }
      : null;
  };
  const finishWire = (target: WireEnd | null, x: number, y: number) => {
    const source = wireRef.current?.source;
    putWire(null);
    const pair = source && target ? editablePair(source, target) : null;
    if (!pair) return;
    if (connectionStrength(pair.goal, pair.project) === "Unmapped")
      onSetConnection(pair.project, pair.goal.projectField!, "Supporting");
    setSelection({ type: "project", id: pair.project.id });
    setTubeMenu({ goalId: pair.goal.id, projectId: pair.project.id, x, y });
  };
  const startWire = (source: WireEnd, el: HTMLElement) => {
    const port = el.getBoundingClientRect(),
      box = stage.current!.getBoundingClientRect();
    putWire({
      source,
      startX: port.left + port.width / 2 - box.left,
      startY: port.top + port.height / 2 - box.top,
      x: port.left + port.width / 2 - box.left,
      y: port.top + port.height / 2 - box.top,
    });
    setTubeMenu(null);
  };
  const port = (end: WireEnd, label: string, disabled: boolean) =>
    !readOnly && (
      <button
        className={`dv-band-port dv-band-port-${end.type}`}
        aria-label={label}
        title={label}
        disabled={disabled}
        aria-pressed={
          wire?.source.type === end.type && wire.source.id === end.id
        }
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          if (wireRef.current) return;
          startWire(end, e.currentTarget);
          wirePointer.current = {
            id: e.pointerId,
            moved: false,
            x: e.clientX,
            y: e.clientY,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onClick={(e) => {
          if (suppress.current) return;
          const source = wireRef.current?.source;
          if (source && (source.type !== end.type || source.id !== end.id))
            finishWire(end, e.clientX, e.clientY);
          else if (!source) startWire(end, e.currentTarget);
        }}
      >
        <span aria-hidden="true">○</span>
      </button>
    );
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (!(e.target instanceof Element)) return;
      if (!e.target.closest("[data-tube-menu],.dv-band-hit")) setTubeMenu(null);
      if (wireRef.current && !e.target.closest(".dv-band-port")) putWire(null);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setTubeMenu(null);
        putWire(null);
        wirePointer.current = null;
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  useEffect(() => {
    if (tubeMenu)
      tubeMenuRef.current
        ?.querySelector<HTMLButtonElement>("button")
        ?.focus({ preventScroll: true });
  }, [tubeMenu]);
  const stage = useRef<HTMLDivElement>(null);
  const suppress = useRef(false);
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
  const sortedProjects = sortConnectionProjects(
    projects,
    selection?.type === "goal"
      ? options.goals.find((g) => g.id === selection.id)
      : undefined,
  );
  const selectBox = (
    type: NonNullable<Selection>["type"],
    id: string,
    e: { target: EventTarget },
  ) => {
    if (
      !(e.target instanceof Element) ||
      e.target.closest(
        'button,input,select,textarea,a,label,[role="textbox"],[data-menu],[data-band-text]',
      )
    )
      return;
    choose(type, id);
  };
  const sortedEntries = [...entries].sort(
    (a, b) =>
      Number(activeEntries.has(b.id)) - Number(activeEntries.has(a.id)) ||
      String(a.name).localeCompare(String(b.name)),
  );
  const choose = (type: NonNullable<Selection>["type"], id: string) => {
    if (!suppress.current) {
      putWire(null);
      setTubeMenu(null);
      setSelection((current) =>
        current?.type === type && current.id === id ? null : { type, id },
      );
    }
  };
  const className = (
    type: NonNullable<Selection>["type"],
    id: string,
    related: boolean,
  ) =>
    `dv-band-node dv-band-${type}${selection?.type === type && selection.id === id ? " selected" : related ? " related" : " dim"}`;
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
        goalId?: string,
        projectId?: string,
      ) => {
        const a = nodes.get(from),
          b = nodes.get(to);
        if (!a?.visible || !b?.visible) return;
        const control = Math.max(35, (b.x - a.right) * 0.55);
        next.push({
          d: `M ${a.right - (goalId ? 8 : 0)} ${a.y} C ${a.right + control} ${a.y}, ${b.x - control} ${b.y}, ${b.x + (goalId ? 8 : 0)} ${b.y}`,
          strength,
          active,
          goalId,
          projectId,
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
              g.id,
              p.id,
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

  return (
    <div className="dv-band-view">
      <div className="dv-band-scroll">
        <div
          className="dv-band-stage"
          ref={stage}
          onPointerMove={(e) => {
            if (wireRef.current) {
              const box = stage.current!.getBoundingClientRect();
              const pointer = wirePointer.current;
              if (
                pointer &&
                Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) > 4
              )
                pointer.moved = true;
              putWire({
                ...wireRef.current,
                x: e.clientX - box.left,
                y: e.clientY - box.top,
              });
              return;
            }
          }}
          onPointerUp={(e) => {
            const pointer = wirePointer.current;
            wirePointer.current = null;
            if (pointer?.moved) {
              suppress.current = true;
              finishWire(
                portEnd(document.elementFromPoint(e.clientX, e.clientY)),
                e.clientX,
                e.clientY,
              );
              setTimeout(() => {
                suppress.current = false;
              }, 80);
            }
          }}
          onPointerCancel={() => {
            wirePointer.current = null;
            putWire(null);
          }}
        >
          <svg
            className="dv-band-lines"
            role="group"
            aria-label="Connection tubes"
          >
            {paths.map((p, i) => {
              const goal = options.goals.find((g) => g.id === p.goalId);
              const project = projects.find((row) => row.id === p.projectId);
              const editable =
                !!goal?.projectField &&
                !!project &&
                canEdit(options.groupCollection, project);
              const openTube = (x: number, y: number) => {
                if (!editable || !goal || !project) return;
                putWire(null);
                setTubeMenu({ goalId: goal.id, projectId: project.id, x, y });
              };
              return (
                <g key={p.goalId ? `${p.goalId}:${p.projectId}` : `entry-${i}`}>
                  <path
                    aria-hidden="true"
                    d={p.d}
                    fill="none"
                    stroke={p.strength === "Primary" ? "#333" : "#999"}
                    strokeWidth={p.strength === "Primary" ? 4 : 2.5}
                    opacity={p.active ? 0.65 : 0.08}
                  />
                  {editable && (
                    <path
                      className="dv-band-hit"
                      d={p.d}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={18}
                      role="button"
                      tabIndex={0}
                      aria-label={`${goal!.label} → ${project!.name}: ${p.strength}`}
                      onClick={(e) => openTube(e.clientX, e.clientY)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          const r = e.currentTarget.getBoundingClientRect();
                          openTube(r.x + r.width / 2, r.y + r.height / 2);
                        }
                      }}
                    />
                  )}
                </g>
              );
            })}
            {wire && (
              <path
                className="dv-band-wire"
                d={`M ${wire.startX} ${wire.startY} C ${wire.startX + (wire.x - wire.startX) * 0.5} ${wire.startY}, ${wire.x - (wire.x - wire.startX) * 0.5} ${wire.y}, ${wire.x} ${wire.y}`}
                fill="none"
                stroke="#777"
                strokeWidth={3}
              />
            )}
          </svg>
          <div className="dv-band-column">
            <h2>Goals</h2>
            <div className="dv-band-list">
              {options.goals.map((g) => (
                <div
                  key={g.id}
                  data-band-node={`goal:${g.id}`}
                  className={className("goal", g.id, activeGoals.has(g.id))}
                  onClick={(e) => selectBox("goal", g.id, e)}
                >
                  {g.projectField &&
                    port(
                      { type: "goal", id: g.id },
                      `Connect ${g.label} to a project`,
                      false,
                    )}
                  <button
                    type="button"
                    className="dv-band-box-select"
                    aria-label={`Select ${g.label}`}
                    aria-pressed={
                      selection?.type === "goal" && selection.id === g.id
                    }
                    onClick={() => choose("goal", g.id)}
                  />
                  <strong className="dv-band-goal-title" data-band-text>
                    {g.label}
                  </strong>
                  <small className="dv-band-goal-description" data-band-text>
                    {g.title}
                  </small>
                </div>
              ))}
            </div>
          </div>
          <div className="dv-band-column">
            <h2>{groupLabel[0].toUpperCase() + groupLabel.slice(1)}s</h2>
            <div className="dv-band-list">
              {sortedProjects.map((p) => (
                <div
                  key={p.id}
                  data-band-node={`project:${p.id}`}
                  className={className(
                    "project",
                    p.id,
                    activeProjects.has(p.id),
                  )}
                  onClick={(e) => selectBox("project", p.id, e)}
                >
                  {options.goals.some((g) => g.projectField) &&
                    port(
                      { type: "project", id: p.id },
                      `Connect ${p.name} to a goal`,
                      !canEdit(options.groupCollection, p),
                    )}
                  <button
                    type="button"
                    className="dv-band-box-select"
                    aria-label={`Select ${p.name}`}
                    aria-pressed={
                      selection?.type === "project" && selection.id === p.id
                    }
                    onClick={() => choose("project", p.id)}
                  />
                  <div className="dv-band-name" title={String(p.name)}>
                    {renderName(options.groupCollection, p)}
                  </div>
                  {renderGroupActions(p)}
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
                  onClick={(event) => selectBox("entry", e.id, event)}
                >
                  <button
                    type="button"
                    className="dv-band-box-select"
                    aria-label={`Select ${e.name}`}
                    aria-pressed={
                      selection?.type === "entry" && selection.id === e.id
                    }
                    onClick={() => choose("entry", e.id)}
                  />
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
      {tubeMenu &&
        (() => {
          const goal = options.goals.find((g) => g.id === tubeMenu.goalId);
          const project = projects.find((p) => p.id === tubeMenu.projectId);
          if (
            !goal?.projectField ||
            !project ||
            !canEdit(options.groupCollection, project)
          )
            return null;
          const current = connectionStrength(goal, project);
          return (
            <div
              ref={tubeMenuRef}
              className="dv-band-tube-menu"
              data-tube-menu
              role="dialog"
              aria-label={`${goal.label} → ${project.name}`}
              style={{
                left: Math.max(
                  8,
                  Math.min(tubeMenu.x, window.innerWidth - 240),
                ),
                top: Math.max(
                  8,
                  Math.min(tubeMenu.y, window.innerHeight - 220),
                ),
              }}
            >
              <strong>
                {goal.label} → {String(project.name)}
              </strong>
              {(["Primary", "Supporting"] as const).map((strength) => (
                <button
                  key={strength}
                  aria-pressed={current === strength}
                  onClick={() => {
                    onSetConnection(project, goal.projectField!, strength);
                    setTubeMenu(null);
                  }}
                >
                  {strength}
                </button>
              ))}
              <button
                className="dv-band-tube-remove"
                onClick={() => {
                  onSetConnection(project, goal.projectField!, "Unmapped");
                  setTubeMenu(null);
                }}
              >
                Remove connection
              </button>
            </div>
          );
        })()}
    </div>
  );
}
