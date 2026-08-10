export const CLI_EXIT = {
  GENERATION_FAILED: 1,
  USAGE_OR_POLICY: 2,
  AUTH: 3,
  NETWORK_OR_POLL: 4,
  TIMEOUT: 5,
  OUTPUT: 6,
} as const;

export class CliCommandError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly reported = false,
  ) {
    super(message);
    this.name = "CliCommandError";
  }
}
