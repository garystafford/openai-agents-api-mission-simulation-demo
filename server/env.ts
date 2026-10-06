import dotenv from "dotenv";

// Load local configuration once, before runtime profiles or tracing are initialized.
dotenv.config({ path: ".env.local" });
