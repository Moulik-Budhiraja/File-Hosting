// CLI commands shown on the System page. Every entry is validated against the
// real CLI parser in cli-examples.test.ts: `fs list` takes no positionals,
// name search is `fs find --name`, and IDs are exactly 7 base62 characters.

export interface CliExample {
  display: string;
  argv: string[];
}

export const CLI_EXAMPLES: CliExample[] = [
  {
    display: "$ fs up ./batch.parquet --tag ingest",
    argv: ["up", "./batch.parquet", "--tag", "ingest"],
  },
  {
    display: "$ fs list --tag ingest --json",
    argv: ["list", "--tag", "ingest", "--json"],
  },
  {
    display: "$ fs find --name '*.parquet' --tag ingest",
    argv: ["find", "--name", "*.parquet", "--tag", "ingest"],
  },
  { display: "$ fs info 9f2c41d", argv: ["info", "9f2c41d"] },
  {
    display: "$ fs visibility 9f2c41d private",
    argv: ["visibility", "9f2c41d", "private"],
  },
  { display: "$ fs rm 9f2c41d --yes", argv: ["rm", "9f2c41d", "--yes"] },
];
