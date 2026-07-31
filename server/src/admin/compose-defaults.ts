// Typed model of the deployment defaults recorded in the repository's
// compose.yaml. The System page renders ONLY from this model, and
// compose-defaults.test.ts parses the real compose.yaml and asserts it still
// matches — so the displayed copy cannot drift from the file silently. The
// running process cannot observe the Docker daemon, so these remain strictly
// configured defaults, never runtime state.

export interface ComposeHealthcheckDefaults {
  interval: string;
  timeout: string;
  retries: number;
  startPeriod: string;
}

export interface ComposeLoggingDefaults {
  driver: string;
  maxSize: string;
  maxFileCount: number;
}

export interface ComposeDefaults {
  healthcheck: ComposeHealthcheckDefaults;
  logging: ComposeLoggingDefaults;
}

export const COMPOSE_DEFAULTS: ComposeDefaults = {
  healthcheck: {
    interval: "30s",
    timeout: "5s",
    retries: 3,
    startPeriod: "20s",
  },
  logging: { driver: "json-file", maxSize: "10m", maxFileCount: 3 },
};

export const COMPOSE_DEFAULT_SOURCE =
  "compose.yaml default; runtime unverified";

function required(text: string, pattern: RegExp, what: string): string {
  const match = pattern.exec(text);
  if (!match?.[1]) {
    throw new Error(`compose.yaml is missing the expected ${what} field`);
  }
  return match[1];
}

// Minimal targeted extraction — enough structure awareness for this
// repository's single-service compose file, and loud when a field vanishes.
export function parseComposeDefaults(yamlText: string): ComposeDefaults {
  const healthcheck = /healthcheck:[\s\S]*?(?=\n[a-z]|\n\S|$)/u.exec(
    yamlText,
  )?.[0];
  if (!healthcheck) {
    throw new Error("compose.yaml is missing the expected healthcheck block");
  }
  const logging = /logging:[\s\S]*?(?=\n {4}\S|\n\S|$)/u.exec(yamlText)?.[0];
  if (!logging) {
    throw new Error("compose.yaml is missing the expected logging block");
  }
  return {
    healthcheck: {
      interval: required(healthcheck, /interval:\s*(\S+)/u, "interval"),
      timeout: required(healthcheck, /timeout:\s*(\S+)/u, "timeout"),
      retries: Number(required(healthcheck, /retries:\s*(\d+)/u, "retries")),
      startPeriod: required(
        healthcheck,
        /start_period:\s*(\S+)/u,
        "start_period",
      ),
    },
    logging: {
      driver: required(logging, /driver:\s*(\S+)/u, "driver"),
      maxSize: required(logging, /max-size:\s*"?([^"\s]+)"?/u, "max-size"),
      maxFileCount: Number(
        required(logging, /max-file:\s*"?(\d+)"?/u, "max-file"),
      ),
    },
  };
}

function displaySize(size: string): string {
  const match = /^(\d+)([kmg])$/iu.exec(size);
  if (!match) return size;
  const unit = { k: "KB", m: "MB", g: "GB" }[match[2]!.toLowerCase()];
  return `${match[1]} ${unit}`;
}

export function healthcheckSummary(
  defaults: ComposeHealthcheckDefaults,
): string {
  return `probes /healthz · interval ${defaults.interval} · timeout ${defaults.timeout} · retries ${defaults.retries} · start period ${defaults.startPeriod} — pass/fail state is only visible to the Docker daemon`;
}

export function loggingSummary(defaults: ComposeLoggingDefaults): string {
  return `compose.yaml routes container stdout to the docker ${defaults.driver} driver, ${displaySize(defaults.maxSize)} × ${defaults.maxFileCount} files — ${COMPOSE_DEFAULT_SOURCE}. There is no log-read API, so no log contents or rotation state can be shown here.`;
}
