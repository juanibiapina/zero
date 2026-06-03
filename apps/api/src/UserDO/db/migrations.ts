import m0000 from "./migrations/0000_initial.sql";
import m0001 from "./migrations/0001_sessions.sql";
import m0002 from "./migrations/0002_mount_configs.sql";
import m0003 from "./migrations/0003_user_settings.sql";
import m0004 from "./migrations/0004_rename_onboarding_seen.sql";
import m0005 from "./migrations/0005_session_type.sql";
import m0006 from "./migrations/0006_session_status.sql";
import m0007 from "./migrations/0007_drop_mount_configs.sql";
import m0008 from "./migrations/0008_session_name.sql";
import m0009 from "./migrations/0009_google_onboarding_status.sql";
import m0010 from "./migrations/0010_user_created_at.sql";

export const migrations = { m0000, m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009, m0010 };
