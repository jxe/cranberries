import { useEffect, useState, type RefObject } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
export type PresenceOptions = { client: SupabaseClient; documentId: string };
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
) {
  const [count, setCount] = useState(0);
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
    let peers: { visitor: string; field: string | null; color: string }[] = [];
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
            node.title = `${new Set(matches.map((p) => p.visitor)).size} other visitor(s) focused here`;
          } else {
            delete node.dataset.presence;
            node.style.removeProperty("--dv-peer-color");
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
          .track({ visitor, color, field: focused })
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
        setCount(new Set(peers.map((p) => p.visitor)).size);
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
          setCount(0);
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
  }, [root, options?.client, options?.documentId]);
  return count;
}
