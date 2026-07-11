---
name: fs
description: Use the fs command-line client for files.moulik.dev to upload files or archived folders, download objects, list and search by name or tag, inspect metadata and URLs, manage tags and visibility, delete entries, and produce script-safe JSON, JSONL, ID, or NUL-delimited output. Use when Codex needs to exchange files through the file-hosting service or provide a hosted preview/raw link.
---

# Use the `fs` file-hosting CLI

Use `fs` for human- or agent-driven file exchange. Expect `FS_URL` and
`FS_TOKEN` to be configured in the environment. The default URL is
`https://files.moulik.dev`. Never print, log, place in a URL, or expose
`FS_TOKEN`.

Run `fs --help` or a command's `--help` for the installed version's exact
syntax. Keep requested data on stdout; allow diagnostics on stderr.

## Upload

Upload a file with the shorthand form and capture its ID:

```sh
id="$(fs ./report.pdf --tag report --id)"
```

Use `up` when an explicit verb reads more clearly:

```sh
fs up ./report.pdf ./chart.png --tag quarterly --jsonl
```

Apply these rules:

- Quote globs when `fs` should expand them consistently, including recursive
  `**`: `fs up '**/*.json' --tag data --jsonl`.
- Expect shell-expanded globs to work too. Expect overlapping matches to be
  de-duplicated and unmatched patterns to exit with status 2.
- Match hidden files only with a pattern that explicitly includes the leading
  dot.
- Add `-r` for every directory upload: `fs -r ./results --id`. Treat the result
  as one `results.tar.gz` object, not as independently hosted children. Expect
  symlinks to be archived as links rather than followed.
- Upload stdin only with a name:
  `producer | fs up - --name output.log --tag logs --id`.
- Expect each matched file or directory to become a separate object.
- Add `--private` for confidential content. Public is the default.

Preview links use `https://files.moulik.dev/<id>` and raw links use
`https://files.moulik.dev/raw/<id>`. HTML and SVG preview pages display escaped
source text rather than executing it.

### Handle uploads over 1 GiB

Treat exit status 7 as a mandatory human-approval boundary. The CLI measures
the combined logical input size before uploading and does not start an upload
when noninteractive approval is missing.

Do not add `--allow-large-upload` on your own. Do not interpret general task
authorization as approval unless the human explicitly approves an upload while
aware that it exceeds 1 GiB.

When approval is missing:

1. Record the total size and exact proposed command.
2. Continue all useful work that does not depend on this upload.
3. Ask the human only when their decision is actually needed, unless approval
   has already been requested.
4. After explicit approval, rerun the same command with
   `--allow-large-upload`.

Never use the flag to bypass authentication, input validation, or a server
storage limit.

## Find and inspect

Use human-readable tables interactively:

```sh
fs list
fs find quarterly
fs find --name '*.pdf' --tag finance --private
fs info Ab12xY9
```

Use structured output for further processing:

```sh
fs list --json
fs find --tag temporary --jsonl
fs info Ab12xY9 --json
fs find --tag temporary --ids
```

Treat repeated `--tag` filters as AND. Treat a bare `find` query as a
case-insensitive substring search across stored names and tags. Treat `--name`
as a stored-filename glob.

Use line-delimited IDs for ordinary loops:

```sh
fs find --tag report --ids |
while IFS= read -r id; do
  fs info "$id" --json
done
```

Use NUL-delimited IDs when composing the safest possible shell pipeline:

```sh
fs find --tag temporary --ids --null |
while IFS= read -r -d '' id; do
  fs --no-input rm "$id" --yes
done
```

Only run the deletion loop when deletion itself is authorized. Never use glob
or wildcard IDs with `down`, `info`, `tag`, `visibility`, or `rm`; pass explicit
seven-character IDs.

## Download

Download using the stored filename or choose a path:

```sh
fs down Ab12xY9
fs down Ab12xY9 -o ./report.pdf
fs down Ab12xY9 -o - | sha256sum
```

Extract only CLI-created folder archives:

```sh
fs down Ab12xY9 --extract -o ./restored-results
```

Expect safe extraction to reject traversal paths and unsafe links. Expect an
existing destination to produce conflict status 5. Use `--force` only when
overwriting that destination is explicitly intended.

## Change metadata or remove entries

```sh
fs tag Ab12xY9 add reviewed important
fs tag Ab12xY9 remove reviewed
fs tag Ab12xY9 set final published
fs tag Ab12xY9 set

fs visibility Ab12xY9 private
fs visibility Ab12xY9 public

fs rm Ab12xY9 --yes
```

Use `tag ... set` with no values to clear all tags. Treat `rm` as destructive:
use `--yes` in noninteractive work only after deletion is within the user's
request. Add `--no-input` to force commands never to prompt.

Private preview and raw requests return the same 404 as missing objects unless
the client supplies authentication. Do not expose private raw responses or the
shared token merely to make a browser preview work.

## Interpret output and failures

Use one output mode at a time:

- `--json`: one JSON document; collection and multi-upload output is an array.
- `--jsonl`: one result per line as it completes.
- `--ids` or upload `--id`: one bare ID per result.
- `--ids --null`: NUL-delimited IDs.

Interpret stable exit statuses as follows:

| Status | Meaning | Agent action |
| ---: | --- | --- |
| 0 | Success | Continue. |
| 1 | General failure | Inspect stderr and correct the operation. |
| 2 | Invalid arguments or unmatched glob | Fix inputs; do not retry unchanged. |
| 3 | Authentication failure | Check configuration without exposing the token. |
| 4 | Not found | Recheck the explicit ID or report that it is gone. |
| 5 | Conflict | Choose another destination or seek overwrite intent. |
| 6 | Network or server failure | Retry only when appropriate; preserve local inputs. |
| 7 | Human approval required | Follow the over-1-GiB workflow above. |
| 8 | Partial success | Preserve successful IDs and retry only failed items. |

Prefer `--jsonl` for multi-object work where partial success is possible. Read
both stdout results and the final exit status; status 8 means some output may
already refer to successfully created or changed objects.
