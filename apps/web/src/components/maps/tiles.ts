/** OpenStreetMap tiles are for development only (decision D-10); production has no tiles yet. */
export const TILES_ENABLED = process.env.NODE_ENV !== "production";
