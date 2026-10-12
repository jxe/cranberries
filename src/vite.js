// Plain JavaScript so Vite can load it from node_modules while reading its config.
import { createRequire } from "node:module";
import { join } from "node:path";
import { loadEnv } from "vite";
/**
 * Exposes the Supabase URL and publishable key, under whichever names the host
 * provides them, as import.meta.env.VITE_SUPABASE_URL and
 * import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY. No other variable is exposed.
 */
export function cranberries(options = {}) {
  return {
    name: "cranberries",
    // With `server`, the dev server answers /api/cranberries itself, as the
    // site's server function does once deployed. Needs `pg` and a database URL.
    configureServer(vite) {
      if (!options.server) return;
      let server;
      vite.middlewares.use("/api/cranberries", async (req, res) => {
        try {
          if (!server) {
            const env = {
              ...loadEnv(vite.config.mode, process.cwd(), ""),
              ...process.env,
            };
            const url = env.DATABASE_URL ?? env.POSTGRES_URL ?? env.DIRECT_URL;
            if (!url) throw Error("Set DATABASE_URL for the server function.");
            const pg = createRequire(join(process.cwd(), "package.json"))("pg");
            const { createServer, pgDatabase } =
              await vite.ssrLoadModule("cranberries/server");
            server = createServer({
              database: pgDatabase(
                new pg.Pool({ connectionString: url, max: 3 }),
              ),
              schema: options.server.schema,
            });
          }
          await server.node(req, res);
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ message: String(error.message) }));
        }
      });
    },
    config(_config, { mode }) {
      const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
      const url =
        env.SUPABASE_URL ??
        env.NEXT_PUBLIC_SUPABASE_URL ??
        env.VITE_SUPABASE_URL ??
        "";
      const key =
        env.SUPABASE_PUBLISHABLE_KEY ??
        env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
        env.SUPABASE_ANON_KEY ??
        env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
        env.VITE_SUPABASE_PUBLISHABLE_KEY ??
        "";
      return {
        // One copy of each, even when this package is linked from a sibling folder.
        resolve: { dedupe: ["react", "react-dom", "@supabase/supabase-js"] },
        // This package is TypeScript source: serve it as site code, and pre-bundle
        // the CommonJS packages it imports, which the dev server would otherwise miss.
        optimizeDeps: {
          exclude: ["cranberries"],
          include: [
            "react",
            "react-dom",
            "react-dom/client",
            "react/jsx-runtime",
            "react/jsx-dev-runtime",
            "@supabase/supabase-js",
          ],
        },
        define: {
          "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(url),
          "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(key),
        },
      };
    },
  };
}
