# `fs` CLI

`fs` is the human- and agent-friendly command-line client for the file hosting
service. It requires Node.js 22 or newer.

## Install for development

```sh
npm install
npm run build
npm link
```

Configure the endpoint and shared bearer token:

```sh
export FS_URL=https://files.moulik.dev  # this is the default
export FS_TOKEN=replace-with-the-shared-secret
```

## Commands

Upload is the default action; `up` is its explicit spelling:

```sh
fs report.pdf --tag report
fs up report.pdf screenshot.png --private
fs up '**/*.json' --tag data
fs -r ./results
some-command | fs up - --name output.log
```

Quoted globs support `*`, `**`, and `?`. Shell-expanded arguments work too,
duplicate matches are uploaded once, and hidden files are matched only by a
pattern that explicitly includes their leading dot. A directory is rejected
unless `-r`/`--recursive` is present; each directory is then stored as one
`.tar.gz` object without following symlinks.

An invocation whose combined logical input size is over 1 GiB needs interactive
human confirmation or an explicit `--allow-large-upload` after approval. In
noninteractive mode it exits with status 7 instead of prompting. `--no-input`
forces noninteractive behavior.

```sh
fs down Ab12xY9
fs down Ab12xY9 -o report.pdf
fs down Ab12xY9 -o - | sha256sum
fs down Ab12xY9 --extract -o ./results

fs list
fs find quarterly --name '*.pdf' --tag finance
fs info Ab12xY9
fs tag Ab12xY9 add reviewed important
fs visibility Ab12xY9 private
fs rm Ab12xY9 --yes
```

Downloads do not overwrite existing paths unless `--force` is supplied.
`--extract` is accepted only for objects recorded as CLI-created `tar.gz`
archives, and extraction rejects traversal paths and unsafe links.

## Scripting

Requested data is written to stdout. Warnings and diagnostics go to stderr.
Collection commands support JSON arrays, streaming JSON Lines, or ID-only
output:

```sh
fs list --json
fs find --tag temporary --jsonl
fs find --tag temporary --ids
fs find --tag temporary --ids --null |
  while IFS= read -r -d '' id; do
    fs --no-input rm "$id" --yes
  done

id="$(fs report.pdf --id)"
fs info "$id" --json
```

The CLI never prompts when standard streams are redirected or when
`--no-input` is set. Output contains no color control sequences.

Stable exit statuses are:

| Status | Meaning |
|---:|---|
| 0 | success |
| 1 | general failure |
| 2 | invalid arguments or unmatched glob |
| 3 | authentication failure |
| 4 | not found |
| 5 | conflict, such as an existing output path |
| 6 | network or server failure |
| 7 | human approval required |
| 8 | partial success |

## Development checks

```sh
npm run typecheck
npm test
npm run build
```
