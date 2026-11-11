import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { Injectable } from "@nestjs/common";
import type { WorkbookGrid } from "@pm-buddy/domain";
import { BQ_IMPORT_LIMITS, type BqFileType } from "@pm-buddy/types";
import { StorageService } from "../../infra/storage.service.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** The parsed grid is bounded by the cell limit; this caps what is ever inflated in memory. */
const MAX_GRID_BYTES = 200 * 1024 * 1024;
const MAX_STORED_GRID_BYTES = 50 * 1024 * 1024;

/**
 * Private object keys for an import, scoped by tenant and project and never derived from the
 * uploaded file name (the database checks the same layout).
 */
export const importKeys = (tenantId: string, projectId: string, importId: string) => {
  const base = `tenants/${tenantId}/projects/${projectId}/bq-imports/${importId}`;
  return {
    source: (fileType: BqFileType) => `${base}/source.${fileType}`,
    parsed: `${base}/parsed.json.gz`,
  };
};

export const CONTENT_TYPES: Record<BqFileType, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
};

/** Stores and loads uploaded sources and parsed grids in the private bucket. */
@Injectable()
export class BqObjectStore {
  constructor(private readonly storage: StorageService) {}

  putSource(key: string, content: Buffer, fileType: BqFileType, sha256: string) {
    return this.storage.put(key, content, CONTENT_TYPES[fileType], sha256);
  }

  getSource(key: string) {
    return this.storage.get(key, BQ_IMPORT_LIMITS.maxFileBytes);
  }

  async putGrid(key: string, grid: WorkbookGrid): Promise<void> {
    const body = await gzipAsync(Buffer.from(JSON.stringify(grid), "utf8"));
    await this.storage.put(key, body, "application/gzip");
  }

  async getGrid(key: string): Promise<WorkbookGrid> {
    const body = await this.storage.get(key, MAX_STORED_GRID_BYTES);
    const json = await gunzipAsync(body, { maxOutputLength: MAX_GRID_BYTES });
    return JSON.parse(json.toString("utf8")) as WorkbookGrid;
  }

  async remove(key: string): Promise<void> {
    await this.storage.delete(key);
  }
}
