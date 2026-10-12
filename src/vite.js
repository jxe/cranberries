// Plain JavaScript so Vite can load it from node_modules while reading its config.
import { loadEnv } from "vite";
/**
 * Exposes the Supabase URL and publishable key, under whichever names the host
 * provides them, as import.meta.env.VITE_SUPABASE_URL and
 * import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY. No other variable is exposed.
 */
export function cranberries() {
  return {
    name: "cranberries",
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
