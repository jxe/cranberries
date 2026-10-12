// Structural on purpose: importing Vite's own types here would tie a linked
// checkout of this package to its own copy of Vite rather than the site's.
export function cranberries(): {
  name: string;
  config(
    config: unknown,
    env: { mode: string },
  ): { resolve: { dedupe: string[] }; define: Record<string, string> };
};
