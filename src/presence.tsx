import { useEffect, useRef, useState, type RefObject } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
export type PresenceOptions = { client: SupabaseClient; documentId: string };
// The person this visitor says they are, and how to draw another visitor's.
export type PresenceFaces = {
  me?: string;
  face: (person: string) => { name: string; image?: string } | undefined;
};
export const fieldKey = (type: string, id: string, field: string) =>
  JSON.stringify([type, id, field]);
const colors = [
  "#9467bd",
  "#00897b",
  "#d16b35",
  "#477ac2",
  "#bb527e",
  "#748c35",
];
export function usePresence(
  root: RefObject<HTMLElement | null>,
  options?: PresenceOptions,
  faces?: PresenceFaces,
) {
  // The people other visitors say they are; undefined for one who has not said.
  const [others, setOthers] = useState<(string | undefined)[]>([]);
  const face = useRef(faces?.face);
  face.current = faces?.face;
  useEffect(() => {
    if (!options || !root.current) return;
    const el = root.current;
    let visitor: string = crypto.randomUUID();
    try {
      visitor = localStorage.getItem("dv-visitor") || visitor;
      localStorage.setItem("dv-visitor", visitor);
    } catch {
      /* Private browsers can still participate for this session. */
    }
    const color =
      colors[
        Array.from(visitor).reduce((n, c) => n + c.charCodeAt(0), 0) %
          colors.length
      ];
    const session = crypto.randomUUID();
    let connected = false,
      stopped = false,
      focused: string | null = null;
    let peers: {
      visitor: string;
      field: string | null;
      color: string;
      person?: string;
    }[] = [];
    const channel = options.client.channel(`presence:${options.documentId}`, {
      config: { presence: { key: session } },
    });
    const paint = () => {
      el.querySelectorAll<HTMLElement>("[data-presence-field]").forEach(
        (node) => {
          const matches = peers.filter(
            (p) => p.field === node.dataset.presenceField,
          );
          if (matches.length) {
            node.dataset.presence = "true";
            node.style.setProperty("--dv-peer-color", matches[0].color);
            // A visitor who has said who they are is shown by face and name.
            const known = matches.flatMap((p) => {
              const who = p.person ? face.current?.(p.person) : undefined;
              return who ? [who] : [];
            });
            const anonymous =
              new Set(matches.map((p) => p.visitor)).size - known.length;
            node.title = [
              ...new Set(known.map((who) => who.name)),
              ...(anonymous > 0 ? [`${anonymous} other visitor(s)`] : []),
            ]
              .join(", ")
              .concat(" here");
            if (known[0]) {
              node.dataset.presenceWho = known[0].name.slice(0, 2);
              if (known[0].image) {
                node.dataset.presenceFace = "true";
                node.style.setProperty(
                  "--dv-peer-image",
                  `url("${encodeURI(known[0].image).replace(/"/g, "%22")}")`,
                );
              } else {
                delete node.dataset.presenceFace;
                node.style.removeProperty("--dv-peer-image");
              }
            } else delete node.dataset.presenceWho;
          } else {
            delete node.dataset.presence;
            delete node.dataset.presenceWho;
            delete node.dataset.presenceFace;
            node.style.removeProperty("--dv-peer-color");
            node.style.removeProperty("--dv-peer-image");
            node.removeAttribute("title");
          }
        },
      );
    };
    let retry: ReturnType<typeof setTimeout> | undefined;
    const publish = () => {
      clearTimeout(retry);
      if (connected && !stopped) {
        void channel
          .track({ visitor, color, field: focused, person: faces?.me ?? null })
          .then((result) => {
            if (result !== "ok" && !stopped) retry = setTimeout(publish, 3000);
          })
          .catch(() => {
            if (!stopped) retry = setTimeout(publish, 3000);
          });
      }
    };
    const update = () => {
      const active = document.activeElement;
      const next =
        document.hasFocus() &&
        !document.hidden &&
        active instanceof Element &&
        el.contains(active)
          ? (active.closest<HTMLElement>("[data-presence-field]")?.dataset
              .presenceField ?? null)
          : null;
      if (next !== focused) {
        focused = next;
        publish();
      }
    };
    const schedule = () =>
      queueMicrotask(() => {
        if (!stopped) update();
      });
    const leave = () => {
      focused = null;
      if (connected) void channel.untrack();
    };
    channel
      .on("presence", { event: "sync" }, () => {
        if (stopped) return;
        peers = Object.entries(channel.presenceState())
          .flatMap(([key, values]) => (key === session ? [] : values))
          .filter(
            (p: any) =>
              typeof p.visitor === "string" &&
              colors.includes(p.color) &&
              (p.field === null || typeof p.field === "string"),
          ) as unknown as typeof peers;
        // Other tabs in this browser share a visitor identity and aren't counted as another person.
        peers = peers.filter((p) => p.visitor !== visitor);
        setOthers(
          [...new Map(peers.map((p) => [p.visitor, p.person])).values()].map(
            (person) => person || undefined,
          ),
        );
        paint();
      })
      .subscribe((status) => {
        connected = status === "SUBSCRIBED";
        if (stopped) return;
        if (connected) {
          update();
          publish();
        } else {
          peers = [];
          setOthers([]);
          paint();
        }
      });
    const observer = new MutationObserver(() => {
      paint();
      schedule();
    });
    observer.observe(el, { childList: true, subtree: true });
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    document.addEventListener("visibilitychange", schedule);
    window.addEventListener("blur", schedule);
    window.addEventListener("focus", schedule);
    window.addEventListener("pagehide", leave);
    return () => {
      stopped = true;
      clearTimeout(retry);
      observer.disconnect();
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      document.removeEventListener("visibilitychange", schedule);
      window.removeEventListener("blur", schedule);
      window.removeEventListener("focus", schedule);
      window.removeEventListener("pagehide", leave);
      peers = [];
      paint();
      void options.client.removeChannel(channel);
    };
  }, [root, options?.client, options?.documentId, faces?.me]);
  return others;
}
