// For seed scripts run with Node, never the browser: they hold the database secret.
export { seedFromEnv, setupDatabase, databaseSql } from "./setup";
export type { SetupOptions } from "./setup";
