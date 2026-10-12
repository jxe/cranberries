// Structural on purpose: importing Vite's own types here would tie a linked
// checkout of this package to its own copy of Vite rather than the site's.
export function cranberries(options?: {
  // Answer /api/cranberries from the dev server; `schema` is where the tables are.
  server?: { schema?: string };
}): {
  name: string;
  configureServer(vite: unknown): void;
  config(
    config: unknown,
    env: { mode: string },
  ): {
    resolve: { dedupe: string[] };
    optimizeDeps: { exclude: string[]; include: string[] };
    define: Record<string, string>;
  };
};
