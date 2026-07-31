import { createWriteStream } from "node:fs";
import { link, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { ApiClient, type ListParams } from "./api.js";
import { loadConfig } from "./config.js";
import { createCredentialStore, readSecret, type CredentialStore } from "./credentials.js";
import { asCliError, CliError, EXIT, type ExitCode } from "./errors.js";
import { extractArchive } from "./extract.js";
import { prepareInputs } from "./inputs.js";
import { chooseOutputMode, formatBytes, printInfo, printItems, type OutputMode } from "./output.js";
import { TransferProgress, type ProgressScheduler, type ProgressSignals } from "./progress.js";
import type { FileMetadata, Streams } from "./types.js";

const LARGE_UPLOAD = 1024 ** 3;
const COMMANDS = new Set(["up", "down", "list", "find", "info", "tag", "visibility", "rm", "auth", "help"]);
const FILE_ID = /^[A-Za-z0-9]{7}$/;

const commonOutputOptions = {
  json: { type: "boolean" },
  jsonl: { type: "boolean" },
  ids: { type: "boolean" },
  id: { type: "boolean" },
  null: { type: "boolean" },
  "no-input": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

export interface RunDependencies {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  streams?: Streams;
  credentials?: CredentialStore;
  readSecret?: () => Promise<string>;
  progressScheduler?: ProgressScheduler;
  progressSignals?: ProgressSignals;
}

const ROOT_HELP = `Usage:
  fs <path...> [options]            Upload (shorthand)
  fs up <path...> [options]         Upload files or archived directories
  fs down <id...> [options]         Download files
  fs list [options]                 List files
  fs find [query] [options]         Search by name and/or tag
  fs info <id...> [options]         Show metadata and URLs
  fs tag <id> add|remove|set <tag...>
  fs visibility <id> public|protected|private
  fs rm <id...> [--yes]             Delete files
  fs auth set|status|delete         Manage the saved token

Environment:
  FS_URL       Server URL (default: https://files.moulik.dev)
  FS_TOKEN     Shared bearer token

Machine output:
  --json       JSON document
  --jsonl      One JSON object per line
  --ids        One ID per line (use --null for NUL delimiters)
  --no-input   Never prompt
`;

const UP_HELP = `Usage: fs [up] <path...> [options]

Paths may be local files, '-', or quoted shell globs using *, **, and ?.
Directories require -r and are uploaded as one .tar.gz object each.

Options:
  -r, --recursive             Archive matched directories
  --name <name>               Stored name (one input only; required for '-')
  --tag <tag>                 Add a tag (repeatable)
  --protected                 Require authentication to read uploaded objects
  --private                   Make uploaded objects owner-only
  --allow-large-upload        Confirm prior human approval above 1 GiB
  --no-input                  Never prompt
  --json | --jsonl | --id     Machine-readable output
`;

const AUTH_HELP = `Usage: fs auth set|status|delete

--no-input is accepted by status and delete, which never prompt. auth set is
interactive and rejects --no-input; use FS_TOKEN in noninteractive environments.
`;

interface ParsedArguments {
  // Node's parseArgs conditional return type becomes unwieldy once common option
  // maps are composed. Command handlers still own and validate each value.
  values: Record<string, any>;
  positionals: string[];
}

function parse(
  args: string[],
  options: Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }>,
): ParsedArguments {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true }) as ParsedArguments;
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error), EXIT.usage, "INVALID_ARGUMENTS");
  }
}

function isTty(stream: NodeJS.ReadableStream | NodeJS.WritableStream): boolean {
  return Boolean((stream as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY);
}

function writeError(streams: Streams, error: CliError, prefix = "fs"): void {
  streams.stderr.write(`${prefix}: ${error.message}\n`);
}

function requireToken(token: string): void {
  if (!token) {
    throw new CliError("No token configured. Run 'fs auth set' or set FS_TOKEN.", EXIT.auth, "MISSING_TOKEN");
  }
}

async function authCommand(args: string[], dependencies: RunDependencies, streams: Streams): Promise<ExitCode> {
  const parsed = parse(args, { "no-input": { type: "boolean" }, help: { type: "boolean", short: "h" } });
  if (parsed.values.help) {
    streams.stdout.write(AUTH_HELP);
    return EXIT.success;
  }
  const [action, ...extra] = parsed.positionals;
  if (extra.length || !action || !["set", "status", "delete"].includes(action)) {
    throw new CliError("Usage: fs auth set|status|delete", EXIT.usage, "INVALID_ARGUMENTS");
  }
  if (action === "set" && parsed.values["no-input"]) {
    throw new CliError(
      "fs auth set is interactive and cannot be used with --no-input; set FS_TOKEN instead",
      EXIT.usage,
      "INTERACTIVE_REQUIRED",
    );
  }
  if (!dependencies.credentials) {
    throw new CliError("Secure credential storage is unavailable", EXIT.auth, "CREDENTIAL_STORE_UNAVAILABLE");
  }
  if (action === "status") {
    const configured = Boolean(dependencies.credentials.getPassword());
    streams.stdout.write(`Authentication: ${configured ? "configured" : "not configured"}\n`);
    return configured ? EXIT.success : EXIT.auth;
  }
  if (action === "delete") {
    const deleted = dependencies.credentials.deletePassword();
    if (!deleted) {
      streams.stderr.write("No saved token was configured.\n");
      return EXIT.auth;
    }
    streams.stderr.write("Saved token deleted from the operating system credential store.\n");
    return EXIT.success;
  }
  if (!dependencies.readSecret) {
    throw new CliError("Secure credential storage is unavailable", EXIT.auth, "CREDENTIAL_STORE_UNAVAILABLE");
  }
  const token = (await dependencies.readSecret()).trim();
  if (!token) throw new CliError("Token cannot be empty", EXIT.usage, "EMPTY_TOKEN");
  dependencies.credentials.setPassword(token);
  streams.stderr.write("Token saved in the operating system credential store.\n");
  return EXIT.success;
}

function validateIds(ids: string[]): void {
  if (ids.length === 0) throw new CliError("At least one file ID is required", EXIT.usage, "MISSING_ID");
  for (const id of ids) {
    if (!FILE_ID.test(id)) {
      throw new CliError(`Invalid file ID (expected 7 base62 characters): ${id}`, EXIT.usage, "INVALID_ID");
    }
  }
}

function tagsFrom(value: string[] | undefined): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const original of value ?? []) {
    const tag = original.trim();
    if (!tag || Buffer.byteLength(tag) > 64 || /[\u0000-\u001f\u007f,]/u.test(tag)) {
      throw new CliError("Tags must be 1-64 UTF-8 bytes and cannot contain commas or control characters", EXIT.usage, "INVALID_TAG");
    }
    const key = tag.toLocaleLowerCase("en-US");
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
  }
  if (tags.length > 20) throw new CliError("At most 20 tags are allowed", EXIT.usage, "INVALID_TAG");
  return tags;
}

function positiveInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliError(`${flag} must be a positive integer`, EXIT.usage, "INVALID_LIMIT");
  }
  return parsed;
}

function enrich(api: ApiClient, item: FileMetadata): FileMetadata {
  return {
    ...item,
    tags: item.tags ?? [],
    archive: item.archive ?? null,
    preview_url: item.preview_url || api.previewUrl(item.id),
    raw_url: item.raw_url || api.rawUrl(item.id),
  };
}

async function confirm(question: string, streams: Streams): Promise<boolean> {
  const rl = createInterface({ input: streams.stdin, output: streams.stderr, terminal: true });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function requireLargeApproval(
  size: number,
  allow: boolean,
  noInput: boolean,
  usesStdin: boolean,
  streams: Streams,
): Promise<void> {
  if (size <= LARGE_UPLOAD || allow) return;
  const interactive = !noInput && !usesStdin && isTty(streams.stdin) && isTty(streams.stderr);
  if (!interactive) {
    throw new CliError(
      `Upload totals ${formatBytes(size)} and requires human approval. Continue unblocked work first, then rerun with --allow-large-upload after approval.`,
      EXIT.approval,
      "HUMAN_APPROVAL_REQUIRED",
    );
  }
  const approved = await confirm(`Upload totals ${formatBytes(size)}. Has a human approved this upload?`, streams);
  if (!approved) {
    throw new CliError("Large upload was not approved", EXIT.approval, "HUMAN_APPROVAL_REQUIRED");
  }
}

async function uploadCommand(
  args: string[],
  api: ApiClient,
  streams: Streams,
  dependencies: RunDependencies,
): Promise<ExitCode> {
  const parsed = parse(args, {
    ...commonOutputOptions,
    recursive: { type: "boolean", short: "r" },
    name: { type: "string" },
    tag: { type: "string", multiple: true },
    protected: { type: "boolean" },
    private: { type: "boolean" },
    "allow-large-upload": { type: "boolean" },
    "no-input": { type: "boolean" },
  });
  if (parsed.values.help) {
    streams.stdout.write(UP_HELP);
    return EXIT.success;
  }
  const mode = chooseOutputMode(parsed.values);
  if (parsed.values.protected && parsed.values.private) {
    throw new CliError(
      "Choose only one of --protected or --private",
      EXIT.usage,
      "VISIBILITY_CONFLICT",
    );
  }
  const tags = tagsFrom(parsed.values.tag);
  const prepared = await prepareInputs(
    parsed.positionals,
    { recursive: parsed.values.recursive ?? false, name: parsed.values.name },
    streams.stdin,
  );
  try {
    await requireLargeApproval(
      prepared.logicalSize,
      parsed.values["allow-large-upload"] ?? false,
      parsed.values["no-input"] ?? false,
      parsed.positionals.includes("-"),
      streams,
    );

    const jsonResults: unknown[] = [];
    let failures = 0;
    let firstFailure: CliError | undefined;
    let successes = 0;
    for (const input of prepared.inputs) {
      const progress = new TransferProgress({
        label: "Uploading",
        name: input.name,
        total: input.uploadSize,
        stderr: streams.stderr,
        scheduler: dependencies.progressScheduler,
        signals: dependencies.progressSignals,
        enabled: mode === "human",
      });
      try {
        const item = enrich(
          api,
          await api.upload({
            name: input.name,
            size: input.uploadSize,
            stream: progress.trackReadable(input.open()),
            tags,
            visibility: parsed.values.protected
              ? "protected"
              : parsed.values.private
                ? "private"
                : "public",
            archive: input.archive,
          }),
        );
        progress.complete();
        successes += 1;
        if (mode === "json") jsonResults.push(item);
        else if (mode === "jsonl") streams.stdout.write(`${JSON.stringify(item)}\n`);
        else if (mode === "ids") streams.stdout.write(`${item.id}${parsed.values.null ? "\0" : "\n"}`);
        else {
          streams.stdout.write(`Uploaded ${input.original}\n`);
          printInfo(streams, item, false);
          if (prepared.inputs.length > 1) streams.stdout.write("\n");
        }
      } catch (error) {
        progress.fail();
        const cliError = asCliError(error);
        firstFailure ??= cliError;
        failures += 1;
        const failure = { input: input.original, error: { code: cliError.code, message: cliError.message } };
        if (mode === "json") jsonResults.push(failure);
        else if (mode === "jsonl") streams.stdout.write(`${JSON.stringify(failure)}\n`);
        writeError(streams, cliError, `fs: ${input.original}`);
      }
    }
    if (mode === "json") streams.stdout.write(`${JSON.stringify(jsonResults)}\n`);
    if (failures === 0) return EXIT.success;
    return successes > 0 || prepared.inputs.length > 1 ? EXIT.partial : firstFailure!.exitCode;
  } finally {
    await prepared.cleanup();
  }
}

async function collect(api: ApiClient, base: ListParams, requestedLimit?: number): Promise<FileMetadata[]> {
  const items: FileMetadata[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const remaining = requestedLimit === undefined ? undefined : requestedLimit - items.length;
    if (remaining !== undefined && remaining <= 0) break;
    const page = await api.list({ ...base, cursor, limit: Math.min(remaining ?? 500, 500) });
    items.push(...page.items.map((item) => enrich(api, item)));
    if (!page.next_cursor || (requestedLimit !== undefined && items.length >= requestedLimit)) break;
    if (seen.has(page.next_cursor)) throw new CliError("Server returned a repeated pagination cursor", EXIT.network, "BAD_CURSOR");
    seen.add(page.next_cursor);
    cursor = page.next_cursor;
  } while (cursor);
  return requestedLimit === undefined ? items : items.slice(0, requestedLimit);
}

async function listCommand(args: string[], api: ApiClient, streams: Streams, find: boolean): Promise<ExitCode> {
  const parsed = parse(args, {
    ...commonOutputOptions,
    tag: { type: "string", multiple: true },
    name: { type: "string" },
    public: { type: "boolean" },
    protected: { type: "boolean" },
    private: { type: "boolean" },
    limit: { type: "string" },
  });
  if (parsed.values.help) {
    streams.stdout.write(
      find
        ? "Usage: fs find [query] [--name <glob>] [--tag <tag>...] [--public|--protected|--private] [--limit N] [--json|--jsonl|--ids]\n"
        : "Usage: fs list [--tag <tag>...] [--public|--protected|--private] [--limit N] [--json|--jsonl|--ids]\n",
    );
    return EXIT.success;
  }
  if (!find && parsed.positionals.length) throw new CliError("fs list does not accept positional arguments", EXIT.usage, "INVALID_ARGUMENTS");
  if (find && parsed.positionals.length > 1) throw new CliError("fs find accepts at most one query", EXIT.usage, "INVALID_ARGUMENTS");
  const visibilityOptions = [parsed.values.public, parsed.values.protected, parsed.values.private].filter(Boolean).length;
  if (visibilityOptions > 1) {
    throw new CliError("Choose only one of --public, --protected, or --private", EXIT.usage, "VISIBILITY_CONFLICT");
  }
  const mode = chooseOutputMode(parsed.values);
  const limit = positiveInteger(parsed.values.limit, "--limit");
  const items = await collect(
    api,
    {
      q: find ? parsed.positionals[0] : undefined,
      name: find ? parsed.values.name : undefined,
      tags: tagsFrom(parsed.values.tag),
      visibility: parsed.values.public
        ? "public"
        : parsed.values.protected
          ? "protected"
          : parsed.values.private
            ? "private"
            : undefined,
    },
    limit,
  );
  printItems(streams, items, mode, parsed.values.null ?? false);
  return EXIT.success;
}

function infoFailure(mode: OutputMode, id: string, error: CliError, streams: Streams, results: unknown[]): void {
  const value = { id, error: { code: error.code, message: error.message } };
  if (mode === "json") results.push(value);
  else if (mode === "jsonl") streams.stdout.write(`${JSON.stringify(value)}\n`);
  writeError(streams, error, `fs: ${id}`);
}

async function infoCommand(args: string[], api: ApiClient, streams: Streams): Promise<ExitCode> {
  const parsed = parse(args, commonOutputOptions);
  if (parsed.values.help) {
    streams.stdout.write("Usage: fs info <id...> [--json|--jsonl]\n");
    return EXIT.success;
  }
  validateIds(parsed.positionals);
  const mode = chooseOutputMode(parsed.values);
  const results: unknown[] = [];
  let successes = 0;
  let failures = 0;
  let firstFailure: CliError | undefined;
  for (const id of parsed.positionals) {
    try {
      const item = enrich(api, await api.info(id));
      successes += 1;
      if (mode === "json") results.push(item);
      else if (mode === "jsonl") streams.stdout.write(`${JSON.stringify(item)}\n`);
      else if (mode === "ids") streams.stdout.write(`${item.id}${parsed.values.null ? "\0" : "\n"}`);
      else {
        printInfo(streams, item, false);
        if (parsed.positionals.length > 1) streams.stdout.write("\n");
      }
    } catch (error) {
      const cliError = asCliError(error);
      firstFailure ??= cliError;
      failures += 1;
      infoFailure(mode, id, cliError, streams, results);
    }
  }
  if (mode === "json") {
    streams.stdout.write(`${JSON.stringify(parsed.positionals.length === 1 && failures === 0 ? results[0] : results)}\n`);
  }
  if (!failures) return EXIT.success;
  return successes ? EXIT.partial : parsed.positionals.length > 1 ? EXIT.partial : firstFailure!.exitCode;
}

async function tagCommand(args: string[], api: ApiClient, streams: Streams): Promise<ExitCode> {
  const parsed = parse(args, { json: { type: "boolean" }, "no-input": { type: "boolean" }, help: { type: "boolean", short: "h" } });
  if (parsed.values.help) {
    streams.stdout.write("Usage: fs tag <id> add|remove|set <tag...> [--json]\n");
    return EXIT.success;
  }
  const [id, operation, ...rawTags] = parsed.positionals;
  if (!id || !operation || !["add", "remove", "set"].includes(operation)) {
    throw new CliError("Usage: fs tag <id> add|remove|set <tag...>", EXIT.usage, "INVALID_ARGUMENTS");
  }
  validateIds([id]);
  if (rawTags.length === 0 && operation !== "set") {
    throw new CliError(`${operation} requires at least one tag`, EXIT.usage, "MISSING_TAG");
  }
  const item = enrich(
    api,
    await api.patch(id, { tags: { operation: operation as "add" | "remove" | "set", values: tagsFrom(rawTags) } }),
  );
  printInfo(streams, item, parsed.values.json ?? false);
  return EXIT.success;
}

async function visibilityCommand(args: string[], api: ApiClient, streams: Streams): Promise<ExitCode> {
  const parsed = parse(args, { json: { type: "boolean" }, "no-input": { type: "boolean" }, help: { type: "boolean", short: "h" } });
  if (parsed.values.help) {
    streams.stdout.write("Usage: fs visibility <id> public|protected|private [--json]\n");
    return EXIT.success;
  }
  const [id, visibility, ...extra] = parsed.positionals;
  if (!id || !visibility || extra.length || !["public", "protected", "private"].includes(visibility)) {
    throw new CliError("Usage: fs visibility <id> public|protected|private", EXIT.usage, "INVALID_ARGUMENTS");
  }
  validateIds([id]);
  const item = enrich(api, await api.patch(id, { visibility: visibility as "public" | "protected" | "private" }));
  printInfo(streams, item, parsed.values.json ?? false);
  return EXIT.success;
}

async function removeCommand(args: string[], api: ApiClient, streams: Streams): Promise<ExitCode> {
  const parsed = parse(args, {
    ...commonOutputOptions,
    yes: { type: "boolean", short: "y" },
    "no-input": { type: "boolean" },
  });
  if (parsed.values.help) {
    streams.stdout.write("Usage: fs rm <id...> [--yes] [--json|--jsonl|--ids]\n");
    return EXIT.success;
  }
  validateIds(parsed.positionals);
  const mode = chooseOutputMode(parsed.values);
  if (!parsed.values.yes) {
    const interactive = !parsed.values["no-input"] && isTty(streams.stdin) && isTty(streams.stderr);
    if (!interactive) throw new CliError("Noninteractive deletion requires --yes", EXIT.usage, "CONFIRMATION_REQUIRED");
    if (!(await confirm(`Delete ${parsed.positionals.length} file(s)?`, streams))) {
      throw new CliError("Deletion cancelled", EXIT.general, "CANCELLED");
    }
  }
  const results: Array<{ id: string; deleted?: true; error?: { code: string; message: string } }> = [];
  let successes = 0;
  let failures = 0;
  let firstFailure: CliError | undefined;
  for (const id of parsed.positionals) {
    try {
      await api.delete(id);
      successes += 1;
      const result = { id, deleted: true as const };
      results.push(result);
      if (mode === "jsonl") streams.stdout.write(`${JSON.stringify(result)}\n`);
      else if (mode === "ids") streams.stdout.write(`${id}${parsed.values.null ? "\0" : "\n"}`);
      else if (mode === "human") streams.stdout.write(`Deleted ${id}\n`);
    } catch (error) {
      const cliError = asCliError(error);
      firstFailure ??= cliError;
      failures += 1;
      const result = { id, error: { code: cliError.code, message: cliError.message } };
      results.push(result);
      if (mode === "jsonl") streams.stdout.write(`${JSON.stringify(result)}\n`);
      writeError(streams, cliError, `fs: ${id}`);
    }
  }
  if (mode === "json") streams.stdout.write(`${JSON.stringify(results)}\n`);
  if (!failures) return EXIT.success;
  return successes ? EXIT.partial : parsed.positionals.length > 1 ? EXIT.partial : firstFailure!.exitCode;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function safeName(name: string, fallback: string): string {
  const value = basename(name.replaceAll("\\", "/"));
  return !value || value === "." || value === ".." ? fallback : value;
}

async function saveResponse(response: Response, destination: string, force: boolean, progress: TransferProgress): Promise<void> {
  if (!response.body) throw new CliError("Download returned an empty body", EXIT.network, "EMPTY_BODY");
  const target = resolve(destination);
  if ((await pathExists(target)) && !force) {
    throw new CliError(`Destination already exists: ${destination} (use --force to replace it)`, EXIT.conflict, "OUTPUT_EXISTS");
  }
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.fs-${process.pid}-${Date.now()}`;
  try {
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      progress.track(),
      createWriteStream(temporary, { flags: "wx" }),
    );
    if (force) {
      await rm(target, { recursive: true, force: true });
      await rename(temporary, target);
    } else {
      await link(temporary, target);
      await rm(temporary, { force: true });
    }
  } catch (error) {
    await rm(temporary, { force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CliError(`Destination already exists: ${destination}`, EXIT.conflict, "OUTPUT_EXISTS");
    }
    throw error;
  }
}

async function downCommand(args: string[], api: ApiClient, streams: Streams, dependencies: RunDependencies): Promise<ExitCode> {
  const parsed = parse(args, {
    output: { type: "string", short: "o" },
    extract: { type: "boolean" },
    force: { type: "boolean" },
    "no-input": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  });
  if (parsed.values.help) {
    streams.stdout.write("Usage: fs down <id...> [-o <path>|-] [--extract] [--force]\n");
    return EXIT.success;
  }
  validateIds(parsed.positionals);
  if (parsed.values.output === "-" && parsed.positionals.length !== 1) {
    throw new CliError("-o - can only be used with one ID", EXIT.usage, "STDOUT_MULTIPLE");
  }
  if (parsed.values.output === "-" && parsed.values.extract) {
    throw new CliError("--extract cannot be combined with -o -", EXIT.usage, "INVALID_ARGUMENTS");
  }
  let outputRoot: string | undefined;
  if (parsed.positionals.length > 1) {
    outputRoot = resolve(parsed.values.output ?? ".");
    if (await pathExists(outputRoot)) {
      const status = await lstat(outputRoot);
      if (!status.isDirectory()) throw new CliError("Multiple downloads require a directory output", EXIT.usage, "OUTPUT_NOT_DIRECTORY");
    } else {
      await mkdir(outputRoot, { recursive: true });
    }
  }

  let successes = 0;
  let failures = 0;
  let firstFailure: CliError | undefined;
  for (const id of parsed.positionals) {
    let progress: TransferProgress | undefined;
    try {
      const item = enrich(api, await api.info(id));
      if (parsed.values.extract && item.archive !== "tar.gz") {
        throw new CliError(`${id} is not a CLI-created tar.gz archive`, EXIT.usage, "NOT_ARCHIVE");
      }
      progress = new TransferProgress({
        label: "Downloading",
        name: item.name,
        total: item.size,
        stderr: streams.stderr,
        scheduler: dependencies.progressScheduler,
        signals: dependencies.progressSignals,
        enabled: parsed.values.output !== "-",
      });
      const response = await api.raw(id);
      if (parsed.values.output === "-") {
        if (!response.body) throw new CliError("Download returned an empty body", EXIT.network, "EMPTY_BODY");
        await pipeline(
          Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
          progress.track(),
          streams.stdout,
        );
      } else if (parsed.values.extract) {
        const temp = await mkdtemp(join(tmpdir(), "fs-down-"));
        try {
          const archivePath = join(temp, "download.tar.gz");
          await saveResponse(response, archivePath, false, progress);
          progress.complete();
          const defaultName = safeName(item.name, id).replace(/\.tar\.gz$/i, "") || id;
          const destination = outputRoot
            ? join(outputRoot, defaultName)
            : resolve(parsed.values.output ?? defaultName);
          await extractArchive(archivePath, destination, parsed.values.force ?? false);
          streams.stdout.write(`Extracted ${id} to ${destination}\n`);
        } finally {
          await rm(temp, { recursive: true, force: true });
        }
      } else {
        const filename = safeName(item.name, id);
        let destination: string;
        if (outputRoot) destination = join(outputRoot, filename);
        else if (parsed.values.output) {
          const requested = resolve(parsed.values.output);
          destination = (await pathExists(requested)) && (await lstat(requested)).isDirectory()
            ? join(requested, filename)
            : requested;
        } else destination = resolve(filename);
        await saveResponse(response, destination, parsed.values.force ?? false, progress);
        progress.complete();
        streams.stdout.write(`Downloaded ${id} to ${destination}\n`);
      }
      if (parsed.values.output === "-") progress.complete();
      successes += 1;
    } catch (error) {
      progress?.fail();
      const cliError = asCliError(error);
      firstFailure ??= cliError;
      failures += 1;
      writeError(streams, cliError, `fs: ${id}`);
    }
  }
  if (!failures) return EXIT.success;
  return successes ? EXIT.partial : parsed.positionals.length > 1 ? EXIT.partial : firstFailure!.exitCode;
}

async function dispatch(argv: string[], dependencies: RunDependencies): Promise<ExitCode> {
  const streams = dependencies.streams ?? { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
  if (argv[0] === "--no-input" && argv[1] && COMMANDS.has(argv[1])) {
    argv = [argv[1], ...argv.slice(2), "--no-input"];
  }
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    streams.stdout.write(ROOT_HELP);
    return EXIT.success;
  }
  if (argv[0] === "--version" || argv[0] === "-V") {
    streams.stdout.write("0.2.0\n");
    return EXIT.success;
  }

  const explicit = COMMANDS.has(argv[0]!);
  const command = explicit ? argv[0]! : "up";
  const args = explicit ? argv.slice(1) : argv;
  const config = loadConfig(dependencies.env);
  const needsToken = !args.includes("--help") && !args.includes("-h");
  const authPositionals = args.filter((arg) => arg !== "--no-input");
  const validAuthAction = command === "auth"
    && authPositionals.length === 1
    && ["set", "status", "delete"].includes(authPositionals[0]!);
  const interactiveAuthSetBlocked = validAuthAction
    && authPositionals[0] === "set"
    && args.includes("--no-input");
  if (command === "auth" && (!validAuthAction || interactiveAuthSetBlocked)) {
    return authCommand(args, dependencies, streams);
  }
  let credentials = dependencies.credentials;
  if (!credentials && validAuthAction) {
    credentials = await createCredentialStore(config.baseUrl);
  } else if (command !== "auth" && !config.token && needsToken) {
    try {
      credentials ??= await createCredentialStore(config.baseUrl);
      config.token = credentials.getPassword() ?? "";
    } catch {
      // Native keyrings may be unavailable in headless sessions. Preserve the
      // environment-variable fallback and report the standard missing-token guidance.
      credentials = undefined;
    }
  }
  const runtimeDependencies: RunDependencies = {
    ...dependencies,
    credentials,
    readSecret: dependencies.readSecret ?? (() => readSecret(streams)),
  };
  if (command === "auth") return authCommand(args, runtimeDependencies, streams);
  if (!args.includes("--help") && !args.includes("-h")) requireToken(config.token);
  const api = new ApiClient(config, dependencies.fetch);
  switch (command) {
    case "up": return uploadCommand(args, api, streams, dependencies);
    case "down": return downCommand(args, api, streams, dependencies);
    case "list": return listCommand(args, api, streams, false);
    case "find": return listCommand(args, api, streams, true);
    case "info": return infoCommand(args, api, streams);
    case "tag": return tagCommand(args, api, streams);
    case "visibility": return visibilityCommand(args, api, streams);
    case "rm": return removeCommand(args, api, streams);
    default: throw new CliError(`Unknown command: ${command}`, EXIT.usage, "UNKNOWN_COMMAND");
  }
}

export async function run(argv: string[], dependencies: RunDependencies = {}): Promise<ExitCode> {
  const streams = dependencies.streams ?? { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
  try {
    return await dispatch(argv, { ...dependencies, streams });
  } catch (error) {
    const cliError = asCliError(error);
    writeError(streams, cliError);
    return cliError.exitCode;
  }
}

export async function main(): Promise<void> {
  process.exitCode = await run(process.argv.slice(2));
}
