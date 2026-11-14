/** OpenStreetMap tiles are for development only (decision D-10); production has no tiles yet. */
export const TILES_ENABLED = process.env.NODE_ENV !== "production";

/** The tile server's origin, which the development Content-Security-Policy allows for images. */
export const TILE_ORIGIN = "https://tile.openstreetmap.org";
export const TILE_URL = `${TILE_ORIGIN}/{z}/{x}/{y}.png`;
