import { table, column } from "do-orm";

export const userSettings = table("user_settings", {
  id: column.integer().primaryKey().autoIncrement(),
  createdAt: column.text(),
  // Canonical IANA name (e.g. "Europe/Berlin"), never an offset. Null until a
  // client reports the device's zone.
  timezone: column.text(),
});
