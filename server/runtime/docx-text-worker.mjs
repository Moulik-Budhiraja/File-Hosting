import { writeSync } from "node:fs";

import yauzl from "yauzl";

const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_XML_BYTES = 256 * 1024;
const chunks = [];
let bytes = 0;

console.log = () => {};
console.info = () => {};
console.warn = () => {};
console.error = () => {};

function openZip(source) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      source,
      { lazyEntries: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) reject(error ?? new Error("zip unavailable"));
        else resolve(zip);
      },
    );
  });
}

function streamFor(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error("entry unavailable"));
      else resolve(stream);
    });
  });
}

try {
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES)
      throw new Error("document input limit exceeded");
    chunks.push(chunk);
  }
  const zip = await openZip(Buffer.concat(chunks));
  const documentEntry = await new Promise((resolve, reject) => {
    let visited = 0;
    zip.on("entry", (entry) => {
      visited += 1;
      if (visited > 512) return reject(new Error("entry limit exceeded"));
      if (entry.fileName === "word/document.xml") return resolve(entry);
      zip.readEntry();
    });
    zip.on("end", () => reject(new Error("document entry absent")));
    zip.on("error", reject);
    zip.readEntry();
  });
  if (
    documentEntry.uncompressedSize > MAX_XML_BYTES ||
    documentEntry.compressedSize > MAX_INPUT_BYTES
  ) {
    throw new Error("document XML limit exceeded");
  }
  const stream = await streamFor(zip, documentEntry);
  const xmlChunks = [];
  let xmlBytes = 0;
  for await (const chunk of stream) {
    xmlBytes += chunk.length;
    if (xmlBytes > MAX_XML_BYTES)
      throw new Error("document XML limit exceeded");
    xmlChunks.push(chunk);
  }
  writeSync(1, Buffer.concat(xmlChunks));
  zip.close();
} catch {
  process.exitCode = 1;
}
