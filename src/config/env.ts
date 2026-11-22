export type EnvIntOptions = {
  defaultValue?: number;
  min?: number;
  max?: number;
};

const DURATION_PATTERN =
  /^(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|y|yrs?|years?)?$/i;

function configured(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function integerRequirement(min?: number, max?: number): string {
  if (min !== undefined && max !== undefined) {
    return `an integer between ${min} and ${max}`;
  }
  if (min === 1) return 'a positive integer';
  if (min === 0) return 'a non-negative integer';
  return 'an integer';
}

export function envInt(
  value: string | undefined,
  name: string,
  options: EnvIntOptions & { defaultValue: number },
): number;
export function envInt(
  value: string | undefined,
  name: string,
  options?: EnvIntOptions,
): number | undefined;
export function envInt(
  value: string | undefined,
  name: string,
  options: EnvIntOptions = {},
): number | undefined {
  const raw = configured(value);
  if (raw === undefined) return options.defaultValue;

  const { min, max } = options;
  const requirement = integerRequirement(min, max);
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${name} must be ${requirement}, received "${raw}"`);
  }

  const parsed = Number(raw);
  if (
    !Number.isSafeInteger(parsed) ||
    (min !== undefined && parsed < min) ||
    (max !== undefined && parsed > max)
  ) {
    throw new Error(`${name} must be ${requirement}, received "${raw}"`);
  }

  return parsed;
}

export function envDuration(value: string | undefined, name: string, defaultValue: string): string;
export function envDuration(
  value: string | undefined,
  name: string,
  defaultValue?: string,
): string | undefined;
export function envDuration(
  value: string | undefined,
  name: string,
  defaultValue?: string,
): string | undefined {
  const raw = configured(value);
  if (raw === undefined) return defaultValue;

  const match = DURATION_PATTERN.exec(raw);
  const amount = match === null ? Number.NaN : Number(match[1]);
  if (match === null || !Number.isFinite(amount) || amount <= 0) {
    throw new Error(
      `${name} must be a positive duration such as "1 minute" or "10000", received "${raw}"`,
    );
  }

  return raw;
}
