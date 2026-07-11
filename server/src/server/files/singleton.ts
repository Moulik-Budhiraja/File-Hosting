import { loadConfig } from "./config";
import { FileService } from "./service";

const globalForFiles = globalThis as typeof globalThis & {
  fileServicePromise?: Promise<FileService>;
};

export function getFileService(): Promise<FileService> {
  globalForFiles.fileServicePromise ??= FileService.create(loadConfig());
  return globalForFiles.fileServicePromise;
}

export function setFileServiceForTests(service: FileService | null): void {
  globalForFiles.fileServicePromise = service
    ? Promise.resolve(service)
    : undefined;
}
