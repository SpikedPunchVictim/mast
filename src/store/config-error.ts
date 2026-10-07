/**
 * Something the user got wrong and can fix: a config value mast rejects, or a
 * project path that is not a directory. The CLI prints the message as one line
 * and exits 1 (`runCli`); any other error keeps its stack trace, because that
 * one is a bug in mast.
 *
 * The message has to stand alone: it names the file or path and what to change.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
