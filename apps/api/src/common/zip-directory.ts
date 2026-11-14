/** Why a zip package is refused (the message says what was wrong, never echoing names). */
export class UnsafeArchive extends Error {}

export type ZipLimits = {
  readonly maxArchiveEntries: number;
  readonly maxUncompressedBytes: number;
  readonly maxCompressionRatio: number;
};

export type ZipSummary = {
  entries: number;
  compressedBytes: number;
  uncompressedBytes: number;
  names: string[];
};

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;

/**
 * Reads a zip central directory (no decompression) and refuses archives that could exhaust
 * memory: more than the uncompressed limit in total, a compression ratio above the limit, too many
 * entries, ZIP64 or encrypted entries, or a directory that does not fit the file. Used for BQ
 * workbooks (D2.2) and Office documents (D8.4); each caller checks the parts it expects.
 */
export function readZipDirectory(content: Buffer, limits: ZipLimits): ZipSummary {
  const unsafe = (message: string) => new UnsafeArchive(message);
  const mb = Math.round(limits.maxUncompressedBytes / (1024 * 1024));
  if (content.length < 22) throw unsafe("The file is not a valid zip package");
  const searchFrom = Math.max(0, content.length - 22 - 0xffff);
  let end = -1;
  for (let position = content.length - 22; position >= searchFrom; position -= 1) {
    if (content.readUInt32LE(position) === EOCD) {
      end = position;
      break;
    }
  }
  if (end < 0) throw unsafe("The file is not a valid zip package");
  const entries = content.readUInt16LE(end + 10);
  const directorySize = content.readUInt32LE(end + 12);
  const directoryOffset = content.readUInt32LE(end + 16);
  if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff)
    throw unsafe("ZIP64 packages are not accepted");
  if (entries > limits.maxArchiveEntries) throw unsafe("The package has too many parts");
  if (directoryOffset + directorySize > end) throw unsafe("The zip directory is inconsistent");

  let position = directoryOffset;
  let compressedBytes = 0;
  let uncompressedBytes = 0;
  const names: string[] = [];
  for (let index = 0; index < entries; index += 1) {
    if (position + 46 > end || content.readUInt32LE(position) !== CENTRAL)
      throw unsafe("The zip directory is inconsistent");
    const flags = content.readUInt16LE(position + 8);
    const compressed = content.readUInt32LE(position + 20);
    const uncompressed = content.readUInt32LE(position + 24);
    const nameLength = content.readUInt16LE(position + 28);
    const extraLength = content.readUInt16LE(position + 30);
    const commentLength = content.readUInt16LE(position + 32);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff)
      throw unsafe("ZIP64 packages are not accepted");
    if (flags & 0x1) throw unsafe("Encrypted parts are not accepted");
    const nameEnd = position + 46 + nameLength;
    if (nameEnd > end) throw unsafe("The zip directory is inconsistent");
    names.push(content.toString("utf8", position + 46, nameEnd));
    compressedBytes += compressed;
    uncompressedBytes += uncompressed;
    if (uncompressedBytes > limits.maxUncompressedBytes)
      throw unsafe(`The package expands to more than ${mb} MB`);
    position = nameEnd + extraLength + commentLength;
  }
  if (uncompressedBytes / Math.max(content.length, 1) > limits.maxCompressionRatio)
    throw unsafe(`The package is compressed more than ${limits.maxCompressionRatio}:1`);
  return { entries, compressedBytes, uncompressedBytes, names };
}
