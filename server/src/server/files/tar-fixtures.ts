// Synthetic ustar fixture builders for tests. Checksums follow the tar spec;
// cross-tool agreement is proven by the root E2E suite, which uploads real
// node-tar archives created by the CLI.
import { gzipSync } from "node:zlib";

const BLOCK = 512;

export interface TarHeaderOptions {
  type?: string;
  linkname?: string;
  // ustar name prefix (offset 345). `magic` is the full 8-byte magic+version
  // field (offset 257); node-tar only honors a prefix when it is exactly
  // "ustar\u000000". `prefixBytes` writes the field verbatim, for headers
  // whose 131st prefix byte (offset 475) is significant.
  prefix?: string;
  prefixBytes?: Buffer;
  magic?: string;
}

export function tarHeader(
  name: string,
  size: number,
  options: TarHeaderOptions = {},
): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, "utf8");
  block.write("0000644\0", 100, 8, "latin1");
  block.write("0000000\0", 108, 8, "latin1");
  block.write("0000000\0", 116, 8, "latin1");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "latin1");
  block.write("00000000000\0", 136, 12, "latin1");
  block.write("        ", 148, 8, "latin1");
  block.write(options.type ?? "0", 156, 1, "latin1");
  if (options.linkname) block.write(options.linkname, 157, 100, "utf8");
  block.write(options.magic ?? "ustar\u000000", 257, 8, "latin1");
  if (options.prefix) block.write(options.prefix, 345, 155, "utf8");
  if (options.prefixBytes) options.prefixBytes.copy(block, 345);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return block;
}

export function tarEntry(
  name: string,
  content: Buffer | string,
  options: TarHeaderOptions = {},
): Buffer {
  const body = Buffer.from(content);
  const padded = Buffer.alloc(Math.ceil(body.length / BLOCK) * BLOCK);
  body.copy(padded);
  return Buffer.concat([tarHeader(name, body.length, options), padded]);
}

export function tarTrailer(): Buffer {
  return Buffer.alloc(2 * BLOCK);
}

export function validTarGz(): Buffer {
  return gzipSync(
    Buffer.concat([
      tarEntry("dir/", "", { type: "5" }),
      tarEntry("dir/hello.txt", "hello world"),
      tarTrailer(),
    ]),
  );
}
